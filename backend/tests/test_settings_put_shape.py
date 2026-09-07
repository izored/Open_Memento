"""PUT /api/settings must answer in the same shape GET does.

It did not, and one line caused two separate bugs.

**It reset the Settings page.** `update_settings()` hands back the raw settings
file, which has none of the keys `get_settings()` computes — `telegram_token_present`,
`yt_cookies_present`, `hidden_passcode_set`, `install_kind` and the rest. The SPA
stores the PUT reply as its whole settings object, so changing the Telegram poll
interval blanked `telegram_token_present`, and the card reads exactly that flag to
decide the bot is configured: the stored token vanished from the UI and the relay
toggle greyed itself out, with the file on disk perfectly intact.

**It leaked secrets.** The same raw dict carries the Telegram bot token, the
locked owner's user id, the hidden-section passcode hash, the music relay session
and the Mesh root secret. GET strips every one; the PUT was returning them all, so
flipping any toggle put the bot token in a response body.

These run the real route function, not a reading of it. Reintroduce
`return update_settings(data)` and both classes below fail.
"""
import pytest

from backend.api.settings import SettingsPatch, write_settings
from backend.core.app_settings import (
    get_settings,
    set_hidden_passcode,
    set_telegram_allowed_user,
    set_telegram_token,
    update_settings,
)

# A syntactically valid BotFather token, so the route's own format check would
# accept it. Never a real one.
_FAKE_TOKEN = "123456789:AAEEabcdefghijklmnopqrstuvwxyz012345"

# Everything get_settings() adds on top of the stored file. A PUT that drops any
# of these blanks it in the SPA, because the reply replaces the settings object.
_COMPUTED_KEYS = [
    "yt_cookies_present",
    "hidden_passcode_set",
    "telegram_token_present",
    "telegram_user_locked",
    "install_kind",
    "platform",
    "ollama_host",
]

# Everything get_settings() strips. A PUT that returns any of these has published
# a secret to whoever made the request.
_SECRET_KEYS = [
    "telegram_bot_token",
    "telegram_allowed_user_id",
    "hidden_passcode_hash",
    "mesh_secret",
    "mesh_code_words",
    "music_relay",
]


@pytest.fixture(autouse=True)
def configured_bot():
    """A bot that is set up and switched on, which is when the bug showed."""
    set_telegram_token(_FAKE_TOKEN)
    set_telegram_allowed_user(4242)
    set_hidden_passcode("test-passcode")
    update_settings({"telegram_enabled": True, "telegram_poll_minutes": 15})
    # Mesh key material is written by core/mesh/secret.py, which this test has no
    # business invoking. Plant it directly: the point is that the PUT does not
    # hand back a key that exists, whoever wrote it.
    from backend.core.app_settings import _LOCK, _read, _write_raw

    with _LOCK:
        current = _read()
        current["mesh_secret"] = "00" * 32
        current["mesh_code_words"] = " ".join(["word"] * 12)
        _write_raw(current)
    yield
    set_telegram_token("")  # also clears the owner lock


class TestPutKeepsComputedKeys:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("key", _COMPUTED_KEYS)
    async def test_reply_carries_every_key_get_computes(self, key):
        reply = await write_settings(SettingsPatch(telegram_poll_minutes=30))
        assert key in reply, f"PUT dropped {key}; the SPA stores this reply wholesale"

    @pytest.mark.asyncio
    async def test_changing_poll_interval_keeps_the_token_visible(self):
        """The exact reported flow: change 'Check every', lose the bot."""
        assert get_settings()["telegram_token_present"] is True
        reply = await write_settings(SettingsPatch(telegram_poll_minutes=30))
        # This is the expression the Settings card evaluates to decide whether a
        # token is stored (`tokenPresent ?? profile?.telegram_token_present ?? false`).
        assert reply.get("telegram_token_present") is True
        assert reply.get("telegram_user_locked") is True
        assert reply.get("telegram_enabled") is True
        assert reply["telegram_poll_minutes"] == 30

    @pytest.mark.asyncio
    async def test_reply_matches_a_fresh_get(self):
        reply = await write_settings(SettingsPatch(telegram_poll_minutes=60))
        assert set(reply) == set(get_settings())


class TestPutLeaksNoSecrets:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("key", _SECRET_KEYS)
    async def test_secret_never_comes_back(self, key):
        reply = await write_settings(SettingsPatch(telegram_poll_minutes=30))
        assert key not in reply, f"PUT returned {key}"

    @pytest.mark.asyncio
    async def test_bot_token_is_nowhere_in_the_body(self):
        """Not just absent under its own key — absent from the body entirely."""
        import json

        reply = await write_settings(SettingsPatch(telegram_poll_minutes=30))
        assert _FAKE_TOKEN not in json.dumps(reply)
