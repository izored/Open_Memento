"""Telegram capture relay (ADR-020).

Store-and-forward phone capture: the user shares a post URL from any app to
their private Telegram bot chat; this service polls Telegram OUTBOUND
(`getUpdates` — no webhook, no inbound port, no public URL) on an interval,
drains every pending message, and saves each URL through the exact same
pipeline as a WebUI paste (`ingest_url_core`). Telegram is the queue: with the
PC asleep, messages simply wait.

Security: messages are processed only when they come from the single locked
owner id. The lock is auto-captured from the FIRST sender after a token is
configured — anyone else is ignored (and logged). Token + owner id live in the
app-settings JSON and never cross the API (app_settings.py).

Cadence (user decision, plan instagram-telegram-capture): poll every
`telegram_poll_minutes` (default 15 — capture is not urgent), then keep an
"active window" of long-polls open for a few minutes after any activity so
collection-button taps get an instant response instead of waiting a full
interval.

Telegram's queue has one hard limit: an undelivered update is kept for **24
hours** and then dropped. Nothing recovers it afterwards (a bot cannot read chat
history), so the whole job of this service on a laptop is to be reachable at
least once a day. `kick()` exists for that: the macOS shell calls it on wake and
unlock, because macOS stops the monotonic clock during system sleep, so a lid
closed for eight hours leaves a 15 minute timer with 15 minutes still to run.
"""
import asyncio
import logging
import os
import random
import re
import uuid
from datetime import datetime, timezone

import httpx

from backend.core.app_settings import (
    get_settings,
    get_telegram_last_success,
    get_telegram_token,
    get_telegram_allowed_user,
    set_telegram_allowed_user,
    set_telegram_last_success,
)
from backend.core.job_handlers import queue_task
from backend.db.database import AsyncSessionLocal

log = logging.getLogger(__name__)

_URL_RE = re.compile(r"https?://\S+")

# How long the post-activity long-poll window stays open, and each long-poll's
# timeout. 25 s is under Telegram's 50 s ceiling and under httpx's read timeout.
_ACTIVE_WINDOW_S = 300
_LONG_POLL_S = 25

# Jitter between two extractions in one batch — spaces out Instagram fetches so
# a backlog drain never looks like a scraper burst.
_BATCH_JITTER_S = (10, 30)

# Live status for the Settings UI (read via /api/settings/telegram/status).
#
# `last_poll_at` is when we last TRIED, `last_success_at` is when Telegram last
# ANSWERED. Keeping only the first one is how the UI used to read "Polling. Last
# check 14:32" through an entire flight with no wifi: every call was failing,
# and every failure was being swallowed one level down.
RELAY_STATUS: dict = {
    "running": False,
    # When this process started polling. Used to tell "brand new" apart from
    # "has never once got through", which are the same None otherwise.
    "running_since": None,
    "last_poll_at": None,
    "last_success_at": None,
    "last_error": None,
    "saved_count": 0,
    # Bumped once per completed cycle, success or failure. "Check now" waits on
    # it: `kick()` only wakes the loop, it cannot report what the loop then
    # found, and a button that greys out for a moment and says nothing is not a
    # check. Watching a counter rather than awaiting an Event keeps this free of
    # the cross-event-loop trap documented on `_KICK` below.
    "poll_seq": 0,
}

# Set to make the loop drain now instead of waiting out its interval. Fired by
# POST /api/settings/telegram/poll-now, which the macOS shell calls on wake and
# unlock and the SPA calls when the network comes back.
#
# Held per event loop, not as one module-level Event: an asyncio.Event binds
# itself to the first loop that touches it and raises on every other one, so a
# single instance breaks the moment the relay is restarted on a fresh loop.
# Rebinding is the WAITER's job only, never the kicker's (see `kick`).
_KICK: asyncio.Event | None = None
_KICK_LOOP: asyncio.AbstractEventLoop | None = None


def _adopt_kick_event() -> asyncio.Event:
    """Take ownership of the kick event for the loop that is about to wait.

    Only the WAITER may (re)bind. An Event belongs to the loop that awaits it,
    so the waiter is the one that knows which loop that is.
    """
    global _KICK, _KICK_LOOP
    loop = asyncio.get_running_loop()
    if _KICK is None or _KICK_LOOP is not loop:
        _KICK = asyncio.Event()
        _KICK_LOOP = loop
    return _KICK


def kick() -> None:
    """Ask the relay to poll immediately. No-op if nothing is waiting.

    Deliberately does NOT create or rebind the event. An earlier version called
    the same helper the waiter used, so a kick arriving from a different loop
    replaced the very Event the relay was parked on: that kick was lost, and so
    was every later one for the rest of the interval, because the relay was
    still awaiting the orphan.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # no running loop, so nothing here is waiting
    if _KICK is None or _KICK_LOOP is not loop:
        return
    _KICK.set()


async def _sleep_or_kick(seconds: float) -> None:
    """Wait out the interval, or return early when someone kicks."""
    event = _adopt_kick_event()
    try:
        await asyncio.wait_for(event.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass
    finally:
        event.clear()


# Telegram drops an undelivered share at 24 hours. Warn at 20, which leaves
# four hours to do something about it, and is far enough from a normal night
# with the lid shut that it never cries wolf.
STALE_AFTER_HOURS = 20.0

# Persisting on every long poll would rewrite the settings file every 25
# seconds. Ten minutes of slack cannot change the answer to "has it been more
# than twenty hours".
#
# Throttled on the WALL clock, not `time.monotonic()`. Monotonic stops during
# macOS sleep, which is the entire environment this feature exists for: a laptop
# that drains once a day accumulates roughly a minute of monotonic time between
# drains, never reaches ten, and never persists. The disk stamp would then sit
# days behind a perfectly healthy relay, and the next launch would read that as
# "we have not reached Telegram in 72 hours" and shout about it.
_SUCCESS_PERSIST_EVERY_S = 600
_last_persisted_iso: str | None = None

# A drain that follows a gap this much longer than the configured interval is a
# catch-up worth telling the owner about, on the phone they shared the links
# from. A flat two hours would fire after every ordinary poll once the interval
# is set to two hours, which the setting allows.
_RECOVERY_NOTICE_HOURS = 2.0

# A relay that has been up this long without Telegram ever answering is broken,
# not new. That is the shape of a mistyped or revoked token.
_NEVER_ANSWERED_GRACE_HOURS = 1.0


def _to_naive_utc(iso: str) -> datetime | None:
    """Parse one of our stamps. None if it is not one.

    `datetime.fromisoformat` accepts offsets and (3.11+) a trailing Z, so a
    stamp written by anything but `utcnow().isoformat()` parses fine and then
    explodes on subtraction against a naive `utcnow()`. That raised out of
    `hours_since_success`, past the guard, into the relay's generic handler, and
    wedged the loop in a 60 second retry that never called Telegram again.
    """
    try:
        then = datetime.fromisoformat(iso)
    except (TypeError, ValueError):
        return None
    if then.tzinfo is not None:
        then = then.astimezone(timezone.utc).replace(tzinfo=None)
    return then


def _note_success() -> None:
    """Record that Telegram answered, in memory always and on disk sometimes."""
    global _last_persisted_iso
    now = datetime.utcnow()
    stamp = now.isoformat()
    RELAY_STATUS["last_success_at"] = stamp

    prior_iso = _last_persisted_iso or get_telegram_last_success()
    prior = _to_naive_utc(prior_iso) if prior_iso else None
    if prior and (now - prior).total_seconds() < _SUCCESS_PERSIST_EVERY_S:
        return
    try:
        set_telegram_last_success(stamp)
        # Only after the write actually landed. Advancing it first meant one
        # transient PermissionError blackholed the stamp for ten minutes, and a
        # lid closed inside that window lost it entirely.
        _last_persisted_iso = stamp
    except Exception as e:  # a settings write must never kill the relay
        log.warning("could not persist telegram last-success: %r", e)


def hours_since_success() -> float | None:
    """Hours since Telegram last answered, across restarts. None if never.

    Falls back to the persisted stamp, which is the whole point: right after a
    launch the in-memory value is empty and the gap is at its widest.
    """
    iso = RELAY_STATUS.get("last_success_at") or get_telegram_last_success()
    if not iso:
        return None
    then = _to_naive_utc(iso)
    if then is None:
        return None
    try:
        return max(0.0, (datetime.utcnow() - then).total_seconds() / 3600)
    except (OverflowError, OSError, ValueError):
        return None


def is_stale() -> bool:
    """Has it been long enough that Telegram is about to start dropping shares?

    "Never answered" counts. It reads as None, every caller treated None as
    healthy, and the user it describes is the worst off of anyone: a token that
    was wrong from the first minute produces no warning anywhere while every
    share they send is discarded a day later.
    """
    hours = hours_since_success()
    if hours is not None:
        return hours >= STALE_AFTER_HOURS
    started = RELAY_STATUS.get("running_since")
    if not started:
        return False
    since = _to_naive_utc(started)
    if since is None:
        return False
    return (datetime.utcnow() - since).total_seconds() / 3600 >= _NEVER_ANSWERED_GRACE_HOURS


class TelegramUnreachable(RuntimeError):
    """Telegram could not be reached, or refused the call.

    Raised on the getUpdates path only. A failed sendMessage is cosmetic: a lost
    receipt is not a lost capture, so those keep returning None.
    """

# getUpdates offset lives in memory only. After a restart Telegram redelivers
# unacked updates; the ingest dedupe (source_url) makes reprocessing harmless.
_offset = 0


def _api(token: str, method: str) -> str:
    return f"https://api.telegram.org/bot{token}/{method}"


async def _tg_strict(client: httpx.AsyncClient, token: str, method: str, **params):
    """One Telegram Bot API call. Raises TelegramUnreachable on any failure.

    Note the `result` payload is returned as-is, so an empty list from a quiet
    getUpdates is a SUCCESS, not a failure. Callers must not treat falsy as
    broken; that conflation is the bug this split exists to prevent.
    """
    try:
        resp = await client.post(_api(token, method), json=params)
        body = resp.json()
    except Exception as e:
        raise TelegramUnreachable(f"{type(e).__name__}: {e}") from e
    # A proxy or captive portal can answer with bare `null` or a list under a
    # JSON content type. `body.get` on that is an AttributeError, which escaped
    # `_tg` too and killed a cycle over a cosmetic sendMessage.
    if not isinstance(body, dict):
        raise TelegramUnreachable(f"unexpected response: {type(body).__name__}")
    if not body.get("ok"):
        raise TelegramUnreachable(str(body.get("description") or "call rejected"))
    return body.get("result")


async def _tg(client: httpx.AsyncClient, token: str, method: str, **params):
    """As `_tg_strict`, but returns None instead of raising. For the chatty
    calls (receipts, keyboards, callback answers) where failing is cosmetic."""
    try:
        return await _tg_strict(client, token, method, **params)
    except TelegramUnreachable as e:
        log.warning("telegram %s: %s", method, scrub_token(str(e)))
        return None


def scrub_token(text: str) -> str:
    """Never let the bot token out in an error string.

    The token is part of the request URL (`_api`), so any exception whose
    message quotes the URL would carry it into `last_error`, which is served by
    an unauthenticated endpoint and written to the shell log.
    """
    token = get_telegram_token()
    return text.replace(token, "<token>") if token else text


async def _get_or_create_collection(db, name: str) -> str:
    """Id of the standard collection with this name (auto-created if missing)."""
    from sqlalchemy import select
    from backend.db.models import Collection

    coll = (
        await db.execute(
            select(Collection).where(
                Collection.name == name, Collection.kind == "standard"
            )
        )
    ).scalars().first()
    if coll is None:
        coll = Collection(
            id=str(uuid.uuid4()),
            workspace_id="default",
            name=name,
            emoji="📸",
            kind="standard",
        )
        db.add(coll)
        await db.commit()
    return coll.id


async def _save_url(url: str, collection_name: str, force_localize: bool) -> dict:
    """Save one URL through the shared ingest pipeline. Never raises."""
    from backend.api.ingest import URLIngest, ingest_url_core

    jobs: list[tuple] = []

    def schedule(fn, *args):
        jobs.append((fn, args))

    try:
        async with AsyncSessionLocal() as db:
            coll_id = await _get_or_create_collection(db, collection_name)
            data = URLIngest(url=url, collection_id=coll_id, force_localize=force_localize)
            result = await ingest_url_core(data, db, schedule)
    except Exception as e:
        log.warning("relay save failed for %s: %r", url, e)
        # `ingest_url_core` commits the memo partway through, so a raise after
        # that point leaves a SAVED memo whose follow-up jobs die in this list.
        # That is exactly how 20 Instagram memos ended up with no video on
        # 2026-09-06 while Telegram said "Save failed". Not queued here on
        # purpose (a genuinely failed save has no memo to work on), but never
        # again silent about it.
        if jobs:
            log.error(
                "relay: dropped %d follow-up job(s) for %s after a mid-save error "
                "- the memo may have committed; check it before re-sending",
                len(jobs), url,
            )
        return {"status": "error", "url": url, "error": str(e)[:120]}

    # Hand every follow-up to the durable queue (ADR-024 §9) rather than
    # starting it here. This path matters most: Telegram is the heaviest ingest
    # route, and a batch of forwarded links used to start a download per link
    # all at once, with every one of them lost if the app restarted mid-run.
    # Jobs are still collected during ingest and only handed over after commit,
    # so nothing is queued for a memo that failed to save.
    for fn, args in jobs:
        queue_task(fn, *args)
    result["url"] = url
    return result


# Buttons per page of the collection keyboard. All collections stay reachable
# via ‹ › paging (Telegram caps a keyboard at 100 buttons; paging keeps the
# receipt compact instead). Text search covers the rest: reply to a receipt
# with a collection name and the memo moves there.
_PAGE_SIZE = 8

# Receipt message id → memo id, so a text REPLY to a "Saved ✓" receipt can be
# routed to the right memo. In-memory, capped; after a restart old receipts
# lose text-search routing (buttons keep working — ids live in callback_data).
_RECEIPT_MEMOS: dict = {}
_RECEIPT_CAP = 300


def _remember_receipt(message_id, memo_id: str) -> None:
    if message_id is None:
        return
    _RECEIPT_MEMOS[message_id] = memo_id
    while len(_RECEIPT_MEMOS) > _RECEIPT_CAP:
        _RECEIPT_MEMOS.pop(next(iter(_RECEIPT_MEMOS)))


async def _all_collections():
    from sqlalchemy import select
    from backend.db.models import Collection

    async with AsyncSessionLocal() as db:
        return (
            await db.execute(
                select(Collection)
                .where(Collection.kind == "standard")
                .order_by(Collection.pinned.desc(), Collection.sort_order, Collection.name)
            )
        ).scalars().all()


async def _collection_keyboard(memo8: str, page: int = 0) -> list:
    """Paged inline keyboard of ALL standard collections (Phase 3).
    callback_data is capped at 64 bytes by Telegram, so 8-char id prefixes are
    used and resolved back with a LIKE match. Nav row: ‹  page/pages  ›."""
    colls = await _all_collections()
    pages = max(1, -(-len(colls) // _PAGE_SIZE))
    page = max(0, min(page, pages - 1))
    subset = colls[page * _PAGE_SIZE:(page + 1) * _PAGE_SIZE]

    rows, row = [], []
    for c in subset:
        row.append({
            "text": f"{c.emoji or ''} {c.name}".strip()[:32],
            "callback_data": f"mv:{memo8[:8]}:{c.id[:8]}",
        })
        if len(row) == 2:
            rows.append(row)
            row = []
    if row:
        rows.append(row)
    if pages > 1:
        # "·" placeholders, never blank — Telegram rejects empty button text.
        rows.append([
            {"text": "‹" if page > 0 else "·", "callback_data": f"pg:{memo8[:8]}:{page - 1}" if page > 0 else "noop"},
            {"text": f"{page + 1}/{pages}", "callback_data": "noop"},
            {"text": "›" if page < pages - 1 else "·", "callback_data": f"pg:{memo8[:8]}:{page + 1}" if page < pages - 1 else "noop"},
        ])
    return rows


def _match_collection(colls, query: str):
    """Find a collection by name: exact (ci) → prefix → substring. None when
    nothing matches — the caller lists what exists."""
    q = query.strip().casefold()
    if not q:
        return None
    for c in colls:
        if c.name.casefold() == q:
            return c
    for c in colls:
        if c.name.casefold().startswith(q):
            return c
    for c in colls:
        if q in c.name.casefold():
            return c
    return None


async def _move_memo(memo_id_prefix: str, collection) -> bool:
    """Re-file a memo (by id or 8-char prefix) into `collection`."""
    from sqlalchemy import select, delete, insert
    from backend.db.models import Memo, memo_collections

    async with AsyncSessionLocal() as db:
        memo = (
            await db.execute(select(Memo).where(Memo.id.like(f"{memo_id_prefix}%")))
        ).scalars().first()
        if not memo:
            return False
        await db.execute(
            delete(memo_collections).where(memo_collections.c.memo_id == memo.id)
        )
        await db.execute(
            insert(memo_collections).values(memo_id=memo.id, collection_id=collection.id)
        )
        await db.commit()
    return True


async def _handle_callback(client, token: str, cq: dict) -> None:
    """A collection button (or pager) was tapped: move the memo / flip the page."""
    from sqlalchemy import select
    from backend.db.models import Collection

    cq_id = cq.get("id")
    data = cq.get("data") or ""
    parts = data.split(":")

    # Pager taps swap the keyboard in place; noop answers the spinner only.
    if parts[0] == "pg" and len(parts) == 3:
        await _tg(client, token, "answerCallbackQuery", callback_query_id=cq_id)
        msg = cq.get("message") or {}
        try:
            page = int(parts[2])
        except ValueError:
            return
        if msg.get("chat"):
            keyboard = await _collection_keyboard(parts[1], page)
            await _tg(
                client, token, "editMessageReplyMarkup",
                chat_id=msg["chat"]["id"],
                message_id=msg.get("message_id"),
                reply_markup={"inline_keyboard": keyboard},
            )
        return
    if len(parts) != 3 or parts[0] != "mv":
        await _tg(client, token, "answerCallbackQuery", callback_query_id=cq_id)
        return
    memo8, coll8 = parts[1], parts[2]

    label = None
    try:
        async with AsyncSessionLocal() as db:
            coll = (
                await db.execute(
                    select(Collection).where(Collection.id.like(f"{coll8}%"))
                )
            ).scalars().first()
        if coll and await _move_memo(memo8, coll):
            label = coll.name
    except Exception as e:
        log.warning("relay move failed (%s): %r", data, e)

    await _tg(
        client, token, "answerCallbackQuery",
        callback_query_id=cq_id,
        text=f"Moved to {label} ✓" if label else "Move failed",
    )
    msg = cq.get("message") or {}
    if label and msg.get("chat"):
        await _tg(
            client, token, "editMessageText",
            chat_id=msg["chat"]["id"],
            message_id=msg.get("message_id"),
            text=f"Saved → {label} ✓",
        )


async def _handle_message(client, token: str, msg: dict, settings: dict) -> str | None:
    """Process one incoming message. Returns "link" when a URL was ingested
    (the only case worth jitter-spacing), "chat" for other replies, None for
    ignored input."""
    from_user = (msg.get("from") or {}).get("id")
    chat_id = (msg.get("chat") or {}).get("id")
    text = msg.get("text") or msg.get("caption") or ""
    if not from_user or not chat_id:
        return None

    allowed = get_telegram_allowed_user()
    if not allowed:
        # First contact after token setup: lock the relay to this sender.
        set_telegram_allowed_user(int(from_user))
        await _tg(
            client, token, "sendMessage", chat_id=chat_id,
            text="🔒 Locked to you. Share a link here and openMemo saves it.",
        )
        allowed = int(from_user)
    if int(from_user) != allowed:
        log.warning("relay ignored message from foreign user id %s", from_user)
        return None

    m = _URL_RE.search(text)
    if not m:
        # Collection search (Phase 3): REPLY to a "Saved ✓" receipt with a
        # collection name and the memo moves there — the buttons' text twin,
        # for libraries too big to page through.
        reply_to = (msg.get("reply_to_message") or {}).get("message_id")
        memo_id = _RECEIPT_MEMOS.get(reply_to) if reply_to else None
        if memo_id:
            colls = await _all_collections()
            target = _match_collection(colls, text)
            if target and await _move_memo(memo_id, target):
                await _tg(
                    client, token, "sendMessage", chat_id=chat_id,
                    text=f"Moved to {target.name} ✓",
                )
            else:
                names = ", ".join(c.name for c in colls[:30])
                await _tg(
                    client, token, "sendMessage", chat_id=chat_id,
                    text=f'No collection matching "{text[:40]}". You have: {names}'[:400],
                )
            return "chat"
        await _tg(
            client, token, "sendMessage", chat_id=chat_id,
            text="Send me a link and I'll save it — or reply to a receipt with a collection name to re-file.",
        )
        return "chat"

    # \S+ grabs trailing prose punctuation ("…/p/XYZ/," ) — strip it so the
    # URL that reaches the pipeline is the URL the user meant.
    url = m.group(0).rstrip(".,;:!?)]}’”")
    inbox = settings.get("telegram_default_collection") or "Bot Inbox"
    result = await _save_url(
        url,
        inbox,
        bool(settings.get("telegram_force_localize", True)),
    )
    status = result.get("status")
    if status == "duplicate":
        await _tg(
            client, token, "sendMessage", chat_id=chat_id,
            text=f"Already saved ✓  ({result.get('title', '')[:60]})",
        )
    elif status == "error":
        await _tg(
            client, token, "sendMessage", chat_id=chat_id,
            text=f"⚠️ Save failed: {result.get('error', 'unknown error')}",
        )
    else:
        RELAY_STATUS["saved_count"] += 1
        keyboard = await _collection_keyboard(result["id"])
        sent = await _tg(
            client, token, "sendMessage", chat_id=chat_id,
            text=f"Saved → {inbox} ✓\n{result.get('title', '')[:80]}",
            reply_markup={"inline_keyboard": keyboard} if keyboard else None,
        )
        if sent:
            _remember_receipt(sent.get("message_id"), result["id"])
    return "link"


async def _drain(client, token: str, settings: dict, timeout: int) -> bool:
    """One getUpdates call + processing. Returns True on any activity.

    Raises TelegramUnreachable when the call itself failed, so the caller can
    tell "nothing new" from "we never got through".
    """
    global _offset
    updates = await _tg_strict(
        client, token, "getUpdates",
        offset=_offset, limit=100, timeout=timeout,
        allowed_updates=["message", "callback_query"],
    )
    _note_success()
    if not updates:
        return False

    activity = False
    for i, u in enumerate(updates):
        _offset = max(_offset, u["update_id"] + 1)
        if u.get("callback_query"):
            await _handle_callback(client, token, u["callback_query"])
            activity = True
        elif u.get("message"):
            handled = await _handle_message(client, token, u["message"], settings)
            activity = activity or bool(handled)
            # Space out extractions inside a multi-link backlog (batch jitter):
            # only after an actual ingest, and only when more messages wait.
            remaining = any("message" in x for x in updates[i + 1:])
            if handled == "link" and remaining:
                await asyncio.sleep(random.uniform(*_BATCH_JITTER_S))
    return activity


def relay_disabled_reason() -> str | None:
    """Why this process must not poll Telegram, or None if it may.

    Two independent guards, because they fail in different directions.

    `OPENMEMO_DISABLE_TELEGRAM` is the explicit one, set by `dev-db.ps1`: a
    backend started against the dev database is a second copy of the app and has
    no business draining the real bot's queue.

    The host lock is the guard for when nobody remembered to set that. Telegram
    gives each message to exactly one caller, so a second poller does not
    duplicate captures — it steals them, silently, into whichever database that
    process happens to be using. See `backend/core/host_lock.py`.
    """
    if os.environ.get("OPENMEMO_DISABLE_TELEGRAM", "").strip().lower() in (
        "1", "true", "yes", "on",
    ):
        return "OPENMEMO_DISABLE_TELEGRAM is set"

    from backend.core.host_lock import claim

    if not claim("telegram-relay"):
        return (
            "another openMemo process on this machine already polls Telegram "
            "(only one may — messages are handed out once, not broadcast)"
        )
    return None


async def run_relay_loop() -> None:
    """Forever loop, started from lifespan. Must never raise out."""
    global _offset

    blocked = relay_disabled_reason()
    if blocked:
        RELAY_STATUS["running"] = False
        RELAY_STATUS["last_error"] = f"relay not started: {blocked}"
        log.warning("telegram relay not started: %s", blocked)
        return

    RELAY_STATUS["running"] = True
    RELAY_STATUS["running_since"] = datetime.utcnow().isoformat()
    log.info("telegram relay loop started")
    while True:
        try:
            settings = get_settings()
            token = get_telegram_token()
            if not settings.get("telegram_enabled") or not token:
                # Kickable, unlike the error backoffs further down. This is an
                # idle wait, not a penalty: turning capture on, or pasting a
                # token, should start polling now rather than up to 30 seconds
                # later — and "Check now" waits on a cycle that would otherwise
                # not begin until this sleep ran out.
                await _sleep_or_kick(30)
                continue

            # Exactly one device may poll (ADR-024 §3). Telegram hands each
            # update to whoever asks first, exactly once, and the offset lives
            # in memory per process — so two devices polling one token race and
            # lose memos outright. Without Mesh this is always True.
            from backend.core.mesh.pairing import may_run_singleton

            if not await may_run_singleton("telegram_relay"):
                await asyncio.sleep(60)
                continue

            minutes = settings.get("telegram_poll_minutes") or 15
            try:
                minutes = max(1, min(120, int(minutes)))
            except (TypeError, ValueError):
                minutes = 15

            # Measured BEFORE the drain: how long we were out of touch, and how
            # many saves this cycle adds. Together they decide whether this was
            # an ordinary poll or a catch-up worth mentioning.
            gap_hours = hours_since_success()
            saved_before = RELAY_STATUS["saved_count"]

            async with httpx.AsyncClient(timeout=httpx.Timeout(_LONG_POLL_S + 10)) as client:
                RELAY_STATUS["last_poll_at"] = datetime.utcnow().isoformat()
                activity = await _drain(client, token, settings, timeout=0)
                RELAY_STATUS["last_error"] = None
                # Bumped HERE, not after the active window below: the window can
                # hold this cycle open for five minutes, and by then whoever
                # pressed "Check now" has long since given up waiting. Everything
                # Telegram was holding has already been drained at this point.
                RELAY_STATUS["poll_seq"] += 1

                # Back after a real absence, with something to show for it. Say
                # so on Telegram: that is the phone the links were shared from,
                # and it answers "did the laptop pick those up" without opening
                # the laptop.
                #
                # Sent before the active window, not after: a wifi drop inside
                # that window raises straight past this block, and by the next
                # cycle the gap has been reset by this drain's own success, so
                # the message could never be sent at all.
                #
                # The threshold scales with the interval. A flat two hours fires
                # after every ordinary poll once the user picks a two hour
                # interval, which the setting offers.
                caught_up = RELAY_STATUS["saved_count"] - saved_before
                owner = get_telegram_allowed_user()
                notice_after = max(_RECOVERY_NOTICE_HOURS, (minutes / 60) * 2)
                if caught_up > 0 and owner and (gap_hours or 0) >= notice_after:
                    await _tg(
                        client, token, "sendMessage", chat_id=owner,
                        text=(
                            f"Back online after {gap_hours:.0f}h. "
                            f"Saved {caught_up} share{'' if caught_up == 1 else 's'} "
                            f"that {'was' if caught_up == 1 else 'were'} waiting."
                        ),
                    )

                # Active window: stay responsive right after activity so button
                # taps and follow-up shares land instantly, then go quiet.
                window_left = _ACTIVE_WINDOW_S if activity else 0
                while window_left > 0:
                    if await _drain(client, token, settings, timeout=_LONG_POLL_S):
                        window_left = _ACTIVE_WINDOW_S
                    else:
                        window_left -= _LONG_POLL_S

            await _sleep_or_kick(minutes * 60)
        except asyncio.CancelledError:
            RELAY_STATUS["running"] = False
            raise
        except TelegramUnreachable as e:
            # Offline, captive portal, revoked token. Say so instead of leaving
            # a stale "last check" on the Settings page looking healthy. Kickable
            # too, so plugging the wifi back in retries at once.
            RELAY_STATUS["last_error"] = scrub_token(str(e))[:200]
            # A failed cycle is still a finished cycle. Without this, "Check now"
            # sits there until it times out and reports nothing, on exactly the
            # occasion the user most needs to be told what went wrong.
            RELAY_STATUS["poll_seq"] += 1
            log.warning("telegram relay could not reach Telegram: %s", scrub_token(str(e)))
            # NOT kickable. This is the backoff, and anything that can interrupt
            # it can also defeat it: a page looping the poll-now endpoint would
            # keep this at zero and hammer Telegram with the user's token until
            # it rate-limits the bot. Sixty seconds against Telegram's 24 hours
            # is a cheap thing to wait.
            await asyncio.sleep(60)
        except Exception as e:
            RELAY_STATUS["last_error"] = scrub_token(str(e))[:200]
            RELAY_STATUS["poll_seq"] += 1  # see above: a failed cycle still ends
            log.error("telegram relay cycle failed: %r", e)
            await asyncio.sleep(60)  # see above: a backoff that can be skipped is not one
