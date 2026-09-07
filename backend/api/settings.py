"""User-configurable settings API (runtime, persisted as JSON)."""
import re
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db.database import get_db

# The music relay is off by default; every route that acts on it 404s until the
# user turns it on (core/music_relay.py), the same way Mesh gates its surface.
from backend.core.music_relay import require_enabled as music_relay_enabled
from backend.core.app_settings import (
    background_present,
    cookies_present,
    delete_background,
    delete_cookies,
    get_background_path,
    get_settings,
    hidden_passcode_set,
    save_background,
    save_cookies,
    set_hidden_passcode,
    update_settings,
    verify_hidden_passcode,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])

# A full multi-site export from the browser extension can reach a few hundred KB;
# cap generously but still hard, so a wrong file can't be dumped here.
_MAX_COOKIES_BYTES = 5 * 1024 * 1024  # 5 MB

# Custom background: store images up to 10 MB full-quality, as-is. Larger images
# route through a (future) lossless-compression seam, not implemented yet.
_MAX_BG_BYTES = 10 * 1024 * 1024  # 10 MB


class SettingsPatch(BaseModel):
    max_upload_mb: Optional[int] = None
    display_name: Optional[str] = None
    email: Optional[str] = None
    avatar_data_url: Optional[str] = None
    mailing_list_consent: Optional[bool] = None
    auto_download_audio: Optional[bool] = None
    auto_download_video: Optional[bool] = None
    auto_file_by_source: Optional[bool] = None
    auto_file_rules: Optional[list[dict]] = None
    music_quality: Optional[str] = None
    music_provider: Optional[str] = None
    chat_model: Optional[str] = None
    num_ctx: Optional[int] = None
    telegram_enabled: Optional[bool] = None
    telegram_poll_minutes: Optional[int] = None
    telegram_default_collection: Optional[str] = None
    telegram_force_localize: Optional[bool] = None
    # Mesh (ADR-024). Must be listed here as well as in _DEFAULTS: this model is
    # a second allowlist, and a key missing from it is dropped silently — the
    # PUT still returns 200, so a Settings toggle would appear to work and do
    # nothing.
    music_relay_enabled: Optional[bool] = None
    mesh_enabled: Optional[bool] = None
    mesh_reachable: Optional[bool] = None
    # Settings card arrangement: {"left": [id...], "right": [id...]}. Free-form
    # on purpose — the ids are frontend card names, and the backend has no
    # opinion about which cards exist.
    settings_card_layout: Optional[dict] = None


async def _seed_auto_file_rules(db) -> None:
    """Turn the built-in list into editable rows, once.

    `auto_file_rules` is None until somebody configures it, which is the signal
    to seed. The built-in list names collections; a rule stores an ID, so the
    names are resolved here where there is a database, and a name that matches
    no collection is simply skipped rather than conjuring one. An empty list is
    NOT None: a user who deleted every rule has configured it, and reseeding
    what they removed would be the rudest possible feature.
    """
    from sqlalchemy import func, select

    from backend.api.ingest import _AUTO_FILE_DOMAINS
    from backend.db.models import Collection

    conf = get_settings()
    if conf.get("auto_file_rules") is not None:
        return
    rules = []
    for domain, name in _AUTO_FILE_DOMAINS.items():
        coll = (
            await db.execute(
                select(Collection).where(func.lower(Collection.name) == name.lower())
            )
        ).scalar_one_or_none()
        if coll is not None:
            rules.append({"domain": domain, "collection_id": coll.id})
    update_settings({"auto_file_rules": rules})


@router.get("")
async def read_settings(db: AsyncSession = Depends(get_db)):
    try:
        await _seed_auto_file_rules(db)
    except Exception:
        # Seeding is a convenience. It must never be the reason Settings fails
        # to load.
        pass
    return get_settings()


def _clean_auto_file_rules(raw: list) -> list[dict]:
    """Normalize, validate and de-duplicate the rules before they are stored.

    Done on the way IN rather than on the way out, so what the user sees in
    Settings is exactly what will be matched later. A rule whose domain cannot
    be a hostname, or which names no collection, is dropped rather than kept as
    a row that silently never fires. First rule for a domain wins; a second is a
    contradiction and the UI does not offer to create one.
    """
    from backend.api.ingest import normalize_rule_domain

    out: list[dict] = []
    seen: set[str] = set()
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        domain = normalize_rule_domain(str(item.get("domain") or ""))
        coll_id = str(item.get("collection_id") or "").strip()
        if not domain or not coll_id or domain in seen:
            continue
        seen.add(domain)
        out.append({"domain": domain, "collection_id": coll_id})
    return out


@router.put("")
async def write_settings(patch: SettingsPatch):
    data = patch.model_dump(exclude_none=True)
    if "auto_file_rules" in data:
        data["auto_file_rules"] = _clean_auto_file_rules(data["auto_file_rules"])
    update_settings(data)
    # Mesh's triggers are physical, so flipping the flag has to change the
    # database, not just a JSON field. Doing it here keeps "enabled" meaning one
    # thing (ADR-024 §0) instead of drifting from what is actually installed.
    if "mesh_enabled" in data:
        from backend.core.mesh import apply_enabled_state

        await apply_enabled_state(bool(data["mesh_enabled"]))
    # Reachability decides which address the listener binds, so changing it has
    # to re-bind. `server.start` returns early when one is already running, so
    # without this the app keeps serving on the address just changed away from.
    if "mesh_reachable" in data and "mesh_enabled" not in data:
        from backend.core.mesh.sync_state import rebind_listener

        await rebind_listener()
    # Return the SAME shape GET does, never `update_settings`'s raw dict. Two
    # separate bugs came out of that one line.
    #
    # It leaked secrets. The raw dict is the settings file, and the file holds
    # the Telegram bot token, the locked owner's user id, the hidden-section
    # passcode hash, the music relay session and the Mesh root secret. GET
    # strips every one of them; the PUT was handing them all back, so changing
    # any toggle on the Settings page put the bot token on the wire.
    #
    # And it reset the UI. The raw dict is missing the computed keys GET adds —
    # `telegram_token_present`, `telegram_user_locked`, `yt_cookies_present`,
    # `hidden_passcode_set`, `install_kind`, `platform`, `ollama_host` — and the
    # SPA stores the reply as its whole settings object. Changing the Telegram
    # poll interval therefore blanked `telegram_token_present`, which is what
    # the card reads to decide the bot is configured: the stored token appeared
    # to vanish and the relay toggle greyed itself out, on disk-perfect state.
    return get_settings()


# --- Hidden-section passcode (OPNMMO-0016) ----------------------------------
# Soft privacy gate for the hidden-memos UI. The hash never leaves the server;
# only `hidden_passcode_set` is exposed. This is NOT an auth layer — the local
# API itself is unauthenticated by design (local-first app).

_MIN_PASSCODE_LEN = 4


class HiddenPasscodeSet(BaseModel):
    passcode: str
    # Required once a passcode exists (change flow); ignored on first set.
    current: Optional[str] = None


class HiddenPasscodeVerify(BaseModel):
    passcode: str


@router.post("/hidden-passcode")
async def write_hidden_passcode(body: HiddenPasscodeSet):
    """Set the hidden-section passcode (first open), or change it given the
    current one."""
    if len(body.passcode) < _MIN_PASSCODE_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"Passcode must be at least {_MIN_PASSCODE_LEN} characters.",
        )
    if hidden_passcode_set():
        if not body.current or not verify_hidden_passcode(body.current):
            raise HTTPException(status_code=403, detail="Current passcode is wrong.")
    set_hidden_passcode(body.passcode)
    return {"hidden_passcode_set": True}


@router.post("/hidden-passcode/verify")
async def check_hidden_passcode(body: HiddenPasscodeVerify):
    if not hidden_passcode_set():
        raise HTTPException(status_code=400, detail="No passcode has been set yet.")
    return {"ok": verify_hidden_passcode(body.passcode)}


# --- Telegram capture relay (ADR-020) ----------------------------------------
# The bot token is a secret: stored in the settings JSON, never returned by any
# endpoint — only `telegram_token_present` is (yt_cookies pattern).


class TelegramTokenSet(BaseModel):
    token: str


@router.post("/telegram/token")
async def write_telegram_token(body: TelegramTokenSet):
    """Store the bot token (empty string clears it and unlocks the owner)."""
    from backend.core.app_settings import set_telegram_token, telegram_token_present

    token = body.token.strip()
    # BotFather tokens look like "<digits>:<35 url-safe chars>". Reject obvious
    # garbage early so a paste mistake fails loudly, not silently at poll time.
    if token and not re.fullmatch(r"\d+:[A-Za-z0-9_-]{30,}", token):
        raise HTTPException(
            status_code=400,
            detail="That doesn't look like a bot token. Copy it from @BotFather.",
        )
    set_telegram_token(token)
    return {"telegram_token_present": telegram_token_present()}


@router.delete("/telegram/user-lock")
async def reset_telegram_user_lock():
    """Forget the locked owner so the next sender re-captures the lock."""
    from backend.core.app_settings import set_telegram_allowed_user, telegram_user_locked

    set_telegram_allowed_user(0)
    return {"telegram_user_locked": telegram_user_locked()}


class PollNow(BaseModel):
    """Body exists to force a CORS preflight, not to carry anything.

    A POST with no body and no content type is a CORS *simple* request: any web
    page the user has open can fire it cross-origin and the browser sends it,
    blocking only the reply. That would let a random site drive this endpoint in
    a loop, and each hit makes the backend call api.telegram.org with the user's
    bot token, from the user's IP, at whatever rate the page likes. Requiring a
    JSON body means a preflight the origin allowlist can refuse.
    """

    reason: Optional[str] = None
    # Seconds to wait for the drain this kick triggers to finish, so a caller
    # can report what happened instead of "sent". 0 / omitted keeps the original
    # fire-and-forget behaviour, which is what the macOS shell and the SPA's
    # back-online handler want: neither has anyone watching a spinner.
    wait_seconds: Optional[float] = None


# Server-side floor on how often a kick may actually do something. Low, because
# the shell deliberately sends two nudges seconds apart on a lid opening: the
# `resume` one fires while Wi-Fi is still reassociating and the `unlock` one
# lands with a working network. A 20 second floor kept the useless one and threw
# away the good one. The thing the floor was really protecting, the relay's error
# backoff, is no longer kickable at all (see run_relay_loop), so this only has to
# stop a flood from being free.
_POLL_NOW_MIN_INTERVAL_S = 5.0
_last_poll_now = 0.0

# Ceiling on `wait_seconds`. A cycle is a getUpdates with timeout=0 plus however
# long the saves take, so it normally lands in under a second; 30 is generous
# room for a slow link and a fat video, and a hard stop on holding a worker.
_POLL_NOW_MAX_WAIT_S = 30.0


@router.post("/telegram/poll-now")
async def poll_telegram_now(body: PollNow):
    """Drain Telegram immediately instead of waiting out the poll interval.

    Called by the macOS shell on wake and unlock, and by the SPA when the
    network comes back. Both matter because macOS stops the monotonic clock
    during system sleep: a lid closed for eight hours leaves a 15 minute timer
    with 15 minutes still to run, and Telegram only holds a share for 24 hours.

    Returns `telegram_enabled` as well, so the caller can decide whether to keep
    the app awake without a second request.
    """
    import asyncio
    import time as _time

    from backend.core.app_settings import get_settings as _get, telegram_token_present
    from backend.services.telegram_relay import (
        RELAY_STATUS,
        hours_since_success,
        is_stale,
        kick,
    )

    global _last_poll_now
    enabled = bool(_get().get("telegram_enabled"))
    running = bool(RELAY_STATUS.get("running"))
    now = _time.monotonic()

    # Why a kick would achieve nothing, named rather than folded into a bare
    # `kicked: false`. The Settings button has to tell the user which of these
    # it is; "nothing happened" is the one answer that helps nobody.
    if not running:
        skipped = "not_running"
    elif not telegram_token_present():
        skipped = "no_token"
    elif not enabled:
        skipped = "disabled"
    elif (now - _last_poll_now) < _POLL_NOW_MIN_INTERVAL_S:
        skipped = "throttled"
    else:
        skipped = None

    seq_before = int(RELAY_STATUS.get("poll_seq") or 0)
    saved_before = int(RELAY_STATUS.get("saved_count") or 0)
    kicked = skipped is None
    if kicked:
        _last_poll_now = now
        kick()

    # Wait for the cycle to actually finish, when asked to. Polling the counter
    # rather than awaiting an Event on purpose: an asyncio.Event binds to the
    # loop that first touches it, and the relay's `_KICK` carries a long comment
    # about what that cost the last time something here reached for one.
    completed = False
    waited = max(0.0, min(float(body.wait_seconds or 0.0), _POLL_NOW_MAX_WAIT_S))
    if kicked and waited:
        deadline = _time.monotonic() + waited
        while _time.monotonic() < deadline:
            if int(RELAY_STATUS.get("poll_seq") or 0) != seq_before:
                completed = True
                break
            await asyncio.sleep(0.1)

    return {
        "kicked": kicked,
        "running": running,
        "telegram_enabled": enabled,
        # None when the kick went through. Otherwise which guard stopped it.
        "skipped_reason": skipped,
        # Did a full cycle land inside `wait_seconds`? False without a wait, and
        # false on a timeout — the poll may still be in flight, so the caller
        # should say "still checking", never "nothing found".
        "completed": completed,
        "saved": (int(RELAY_STATUS.get("saved_count") or 0) - saved_before) if completed else 0,
        # Set by the cycle we just waited on, so it explains THIS check.
        "last_error": RELAY_STATUS.get("last_error") if completed else None,
        # The caller (the macOS shell, on wake) uses this to decide whether to
        # put a notification on screen. Reported before the kick has had time to
        # land, which is correct: it describes the gap being recovered from.
        # `hours_since_success` is None when Telegram has NEVER answered, so
        # `stale` is the flag to branch on, not the number.
        "hours_since_success": hours_since_success(),
        "stale": bool(enabled and is_stale()),
    }


@router.get("/telegram/status")
async def read_telegram_status():
    """Live relay status for the Settings card."""
    from backend.core.app_settings import (
        get_telegram_last_success,
        telegram_token_present,
        telegram_user_locked,
    )
    from backend.services.telegram_relay import (
        RELAY_STATUS,
        STALE_AFTER_HOURS,
        hours_since_success,
        is_stale,
    )

    return {
        **RELAY_STATUS,
        # Falls back to the persisted stamp, so a freshly launched app can still
        # say when it last got through instead of showing a blank.
        "last_success_at": RELAY_STATUS.get("last_success_at") or get_telegram_last_success(),
        "hours_since_success": hours_since_success(),
        "stale": is_stale(),
        "stale_after_hours": STALE_AFTER_HOURS,
        "telegram_token_present": telegram_token_present(),
        "telegram_user_locked": telegram_user_locked(),
    }


def _looks_like_cookie_jar(text: str) -> bool:
    """Lenient Netscape cookies.txt check: a known header, or any data line with
    the 7 tab-separated columns (domain, flag, path, secure, expiry, name, value).
    Exporters vary, so we don't demand the header."""
    if "# Netscape HTTP Cookie File" in text or "# HTTP Cookie File" in text:
        return True
    for line in text.splitlines():
        line = line.rstrip("\n")
        if not line or line.startswith("#"):
            continue
        if line.count("\t") >= 6:
            return True
    return False


@router.post("/cookies")
async def upload_cookies(file: UploadFile = File(...)):
    """Store a yt-dlp cookie jar (Netscape cookies.txt) used to download
    age-restricted / private / login-gated sources. Never echoed back."""
    raw = await file.read()
    if len(raw) > _MAX_COOKIES_BYTES:
        raise HTTPException(status_code=413, detail="Cookie file is too large.")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Not a text cookie file.")
    if not _looks_like_cookie_jar(text):
        raise HTTPException(
            status_code=400,
            detail="That doesn't look like a cookies.txt file. Export it in Netscape format.",
        )
    save_cookies(text)
    return {"yt_cookies_present": True}


@router.delete("/cookies")
async def remove_cookies():
    delete_cookies()
    return {"yt_cookies_present": cookies_present()}


# --- Instagram login (final-fallback session for IG pulls) ------------------
# Feeds the same shared cookie jar as /cookies, but scoped to Instagram. Two
# ways in: paste a session (safe, no password) or username+password headless
# login (convenient, but IG may checkpoint your main account — the UI warns).


class InstagramSession(BaseModel):
    # A pasted Netscape cookies.txt (only its instagram.com lines are taken).
    cookies: str


class InstagramLogin(BaseModel):
    username: str
    password: str


@router.get("/instagram/status")
async def instagram_status():
    from backend.core.instagram_login import session_status
    return session_status()


# How many recent Instagram saves the health check looks at, and the share of
# them that must have landed on a fallback tier before we say anything. One
# throttled save is noise; most of the last dozen is a broken setup.
_IG_HEALTH_WINDOW = 12
_IG_HEALTH_RATIO = 0.5



@router.get("/instagram/health")
async def instagram_health():
    """Is Instagram actually resolving properly, or only appearing to?

    A tier ladder degrades silently: every tier returns a memo, so a lapsed
    session looks exactly like success until you notice reels arriving as
    stills. This reports what the last few saves actually used, so the UI can
    say so out loud (plan 026).
    """
    from sqlalchemy import select

    from backend.core.extractor import IG_FALLBACK_TIERS, IG_TIER_BLOCKED
    from backend.core.instagram_login import session_status
    from backend.db.database import AsyncSessionLocal
    from backend.db.models import Memo

    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Memo.resolve_tier)
                .where(
                    Memo.source_url.like("%instagram.com%"),
                    Memo.resolve_tier.isnot(None),
                    (Memo.is_deleted == False) | (Memo.is_deleted == None),  # noqa: E712
                )
                .order_by(Memo.created_at.desc())
                .limit(_IG_HEALTH_WINDOW)
            )
        ).scalars().all()

    session = session_status()
    tiers = [t for t in rows if t]
    degraded = [t for t in tiers if t in IG_FALLBACK_TIERS]
    blocked = [t for t in tiers if t == IG_TIER_BLOCKED]
    # No tagged saves yet (a library from before this shipped) is not a
    # problem to report — there is simply nothing to judge.
    unhealthy = bool(tiers) and len(degraded) / len(tiers) >= _IG_HEALTH_RATIO

    # The canary is the other half: saves only reveal a problem once you make
    # one, so a weekly re-check catches a lapsed session while the library is
    # sitting idle (core/canary.py).
    from backend.core.canary import last_result

    canary = last_result()
    if canary and canary.get("status") == "degraded":
        unhealthy = True

    if not unhealthy:
        status = "ok"
    elif session.get("connected"):
        # Cookies are present and saves STILL cannot reach the API: the jar is
        # there but Instagram is not accepting it any more.
        status = "session_expired"
    else:
        status = "no_session"

    return {
        "status": status,
        "connected": bool(session.get("connected")),
        "checked": len(tiers),
        "degraded": len(degraded),
        "blocked": len(blocked),
        "recent_tiers": tiers,
        "canary": canary,
    }


@router.post("/instagram/session")
async def instagram_import_session(data: InstagramSession):
    """Import an Instagram session from a pasted cookies.txt. No password."""
    if len(data.cookies) > _MAX_COOKIES_BYTES:
        raise HTTPException(status_code=413, detail="Cookie text is too large.")
    from backend.core.instagram_login import import_session_cookies
    result = import_session_cookies(data.cookies)
    if result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.post("/instagram/login")
async def instagram_login(data: InstagramLogin):
    """Headless username/password login. The password is used once to sign in and
    is never stored or logged. May return a checkpoint/2FA status IG imposes."""
    from backend.core.instagram_login import login_with_password
    result = await login_with_password(data.username.strip(), data.password)
    status = result.get("status")
    if status == "ok":
        return result
    messages = {
        "bad_credentials": "Instagram rejected that username or password.",
        "two_factor": "Instagram asked for a 2FA code. Use 'Import session' instead.",
        "checkpoint": "Instagram flagged this login (checkpoint). Use 'Import session' instead.",
        "unavailable": "Automated login isn't available here. Use 'Import session' instead.",
    }
    raise HTTPException(status_code=400, detail=messages.get(status, "Instagram login failed."))


@router.delete("/instagram/session")
async def instagram_disconnect():
    """Remove only the Instagram cookies from the shared jar."""
    from backend.core.instagram_login import disconnect
    return disconnect()


# --- Custom appearance background ------------------------------------------

# Magic-byte sniff -> canonical extension. We trust content, not the filename.
_IMAGE_SIGNATURES = (
    (b"\xff\xd8\xff", "jpg"),
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)


def _sniff_image_ext(raw: bytes) -> str | None:
    for sig, ext in _IMAGE_SIGNATURES:
        if raw.startswith(sig):
            return ext
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return None


def _lossless_compress_seam(raw: bytes) -> bytes:
    """Architecture seam for future lossless compression of large backgrounds.

    Deliberately NOT implemented yet (no compressor dependency, per OPNMMO-0018).
    Until it lands, images over the cap are declined here. When compression is
    built, this is the single place to slot it in and return the smaller bytes.
    """
    raise HTTPException(
        status_code=413,
        detail="Image over 10 MB. Lossless compression for large backgrounds is "
        "coming in a future update — please use a smaller image for now.",
    )


@router.post("/background")
async def upload_background(file: UploadFile = File(...)):
    """Store a custom appearance background full-quality (server-side, not a
    localStorage data URL). Returns the active extension; the image is served by
    GET /api/settings/background."""
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(raw) > _MAX_BG_BYTES:
        raw = _lossless_compress_seam(raw)  # placeholder: declines >10 MB for now
    ext = _sniff_image_ext(raw)
    if not ext:
        raise HTTPException(
            status_code=400,
            detail="Unsupported image type. Use JPG, PNG, WEBP or GIF.",
        )
    save_background(raw, ext)
    return {"bg_image_ext": ext}


@router.get("/background")
async def read_background():
    p = get_background_path()
    if not p:
        raise HTTPException(status_code=404, detail="No custom background set.")
    return FileResponse(p)


@router.delete("/background")
async def remove_background():
    delete_background()
    return {"bg_image_present": background_present()}


@router.get("/library/integrity")
async def library_integrity():
    """What the last integrity check found (core/integrity.py).

    Runs one on demand if none has been stored yet, so a fresh install answers
    with a real number instead of a null the UI has to explain. Cheap enough
    that this is not worth a background wait."""
    from backend.core.integrity import last_result, run_integrity_check, store

    result = last_result()
    if result is None:
        result = await run_integrity_check()
        await store(result)
    return result


@router.post("/library/integrity/check")
async def library_integrity_check():
    """Run the check now and store the result.

    Storing matters: the stored count is what the NEXT run compares against, so
    an on-demand check after a known-good restore is also how you clear a stale
    "incident" without waiting an hour."""
    from backend.core.integrity import run_integrity_check, store

    result = await run_integrity_check()
    await store(result)
    return result


@router.get("/music-relay/status")
async def music_relay_status():
    """Whether the lossless music relay session is usable. Never the secret.

    Deliberately NOT behind `require_enabled`: Settings needs to render the
    relay card while the feature is off, and this answers `enabled: false` with
    no secret and no outbound call. Every route that *does* something is gated.
    """
    from backend.core.music_relay import status

    return status()


class MusicRelayStart(BaseModel):
    # openMemo's origin AS THE BROWSER SEES IT. The browser is what gets
    # redirected back after the challenge, and behind nginx or in Docker that
    # address is not the one the server sees, so the client supplies it.
    callback_base: str


@router.post("/music-relay/verify/start", dependencies=[Depends(music_relay_enabled)])
async def music_relay_verify_start(data: MusicRelayStart):
    """Get the challenge link for the user to open and complete themselves."""
    from backend.core.music_relay import RelayNotVerified, start_verification

    try:
        return start_verification(data.callback_base)
    except RelayNotVerified as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/music-relay/verify/callback", dependencies=[Depends(music_relay_enabled)])
async def music_relay_verify_callback(state: str = "", grant: str = ""):
    """Where the relay sends the user's browser once the challenge is done.

    This is a page a person lands on, not an API call the app makes, so it
    answers in HTML and closes itself."""
    from fastapi.responses import HTMLResponse

    from backend.core.music_relay import RelayNotVerified, complete_verification

    try:
        complete_verification(state, grant)
        headline, detail, ok = "Verified", "Returning to openMemo…", True
    except RelayNotVerified as e:
        headline, detail, ok = "Verification failed", str(e), False

    return HTMLResponse(
        "<!doctype html><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width,initial-scale=1'>"
        f"<title>{headline}</title>"
        "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;"
        "font:15px/1.6 system-ui,sans-serif;background:#0b0b0c;color:#f5f5f5;padding:24px}"
        "main{text-align:center;max-width:34rem}h1{font-size:22px;margin:0 0 8px;font-weight:500}"
        "p{margin:0;color:#8a8a8a}</style>"
        f"<main><h1>{headline}</h1><p>{detail}</p></main>"
        + ("<script>setTimeout(()=>window.close(),1200)</script>" if ok else ""),
        status_code=200 if ok else 400,
    )


@router.delete("/music-relay/session", dependencies=[Depends(music_relay_enabled)])
async def music_relay_disconnect():
    """Forget the stored session. The install id stays, so re-verifying is the
    same client rather than a new one."""
    from backend.core.music_relay import disconnect

    return disconnect()
