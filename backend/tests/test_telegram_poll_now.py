"""POST /api/settings/telegram/poll-now — the "Check now" button's endpoint.

The button has to say what happened, and there are only two ways to get that
wrong: claim a check ran when the kick went nowhere, or claim nothing was waiting
when the poll had not finished yet. Both would be worse than no button, because
the person pressing it is already unsure the relay works.

So this pins the contract the UI branches on: `skipped_reason` names which guard
stopped a kick, and `completed` is true only when a real cycle finished inside
the wait. These call the route function against the relay's real RELAY_STATUS.
"""
import asyncio

import pytest

from backend.api import settings as settings_api
from backend.api.settings import PollNow, poll_telegram_now
from backend.core.app_settings import set_telegram_token, update_settings
from backend.services.telegram_relay import RELAY_STATUS

_FAKE_TOKEN = "123456789:AAEEabcdefghijklmnopqrstuvwxyz012345"


@pytest.fixture(autouse=True)
def relay_state():
    """A relay that is running, configured and on, with the throttle rearmed."""
    before = dict(RELAY_STATUS)
    RELAY_STATUS.update({"running": True, "poll_seq": 0, "saved_count": 0, "last_error": None})
    set_telegram_token(_FAKE_TOKEN)
    update_settings({"telegram_enabled": True})
    # The floor is module state and 5 seconds long, so back-to-back tests would
    # otherwise see each other's kicks as a flood.
    settings_api._last_poll_now = 0.0
    yield
    RELAY_STATUS.clear()
    RELAY_STATUS.update(before)
    set_telegram_token("")


async def _bump_after(delay: float, saved: int = 0) -> None:
    """Stand in for the relay finishing a cycle."""
    await asyncio.sleep(delay)
    RELAY_STATUS["saved_count"] += saved
    RELAY_STATUS["poll_seq"] += 1


class TestSkippedReason:
    async def test_relay_not_running(self):
        RELAY_STATUS["running"] = False
        r = await poll_telegram_now(PollNow(reason="manual"))
        assert r["kicked"] is False and r["skipped_reason"] == "not_running"

    async def test_no_token(self):
        set_telegram_token("")
        r = await poll_telegram_now(PollNow(reason="manual"))
        assert r["kicked"] is False and r["skipped_reason"] == "no_token"

    async def test_capture_switched_off(self):
        update_settings({"telegram_enabled": False})
        r = await poll_telegram_now(PollNow(reason="manual"))
        assert r["kicked"] is False and r["skipped_reason"] == "disabled"

    async def test_second_press_within_the_floor_is_throttled(self):
        first = await poll_telegram_now(PollNow(reason="manual"))
        assert first["kicked"] is True and first["skipped_reason"] is None
        second = await poll_telegram_now(PollNow(reason="manual"))
        assert second["kicked"] is False and second["skipped_reason"] == "throttled"


class TestWaiting:
    async def test_no_wait_returns_at_once_and_claims_nothing(self):
        r = await poll_telegram_now(PollNow(reason="online"))
        # The macOS shell and the back-online handler take this path. A kick was
        # sent; nothing is known about what it found, and nothing is claimed.
        assert r["kicked"] is True
        assert r["completed"] is False
        assert r["saved"] == 0

    async def test_waits_for_the_cycle_and_reports_what_it_saved(self):
        task = asyncio.create_task(_bump_after(0.2, saved=3))
        r = await poll_telegram_now(PollNow(reason="manual", wait_seconds=5))
        await task
        assert r["completed"] is True
        assert r["saved"] == 3
        assert r["last_error"] is None

    async def test_an_empty_poll_completes_with_nothing_saved(self):
        task = asyncio.create_task(_bump_after(0.2, saved=0))
        r = await poll_telegram_now(PollNow(reason="manual", wait_seconds=5))
        await task
        assert r["completed"] is True and r["saved"] == 0

    async def test_a_failed_cycle_still_completes_and_carries_the_error(self):
        async def fail_after() -> None:
            await asyncio.sleep(0.2)
            RELAY_STATUS["last_error"] = "could not reach Telegram"
            RELAY_STATUS["poll_seq"] += 1

        task = asyncio.create_task(fail_after())
        r = await poll_telegram_now(PollNow(reason="manual", wait_seconds=5))
        await task
        assert r["completed"] is True
        assert r["last_error"] == "could not reach Telegram"

    async def test_timeout_reports_incomplete_never_empty(self):
        """Nothing bumps the counter, so the wait runs out.

        `completed: False` with `saved: 0` is the whole point: the poll may still
        be in flight, and reporting "nothing waiting" here would be a lie the
        user cannot check.
        """
        r = await poll_telegram_now(PollNow(reason="manual", wait_seconds=0.3))
        assert r["kicked"] is True
        assert r["completed"] is False
        assert r["saved"] == 0
        assert r["last_error"] is None

    async def test_wait_is_capped(self, monkeypatch):
        """A caller cannot pin a worker for an hour by asking nicely."""
        import time

        # Clamped to the real ceiling in production; shrunk here so the suite
        # does not spend half a minute proving a `min()`.
        monkeypatch.setattr(settings_api, "_POLL_NOW_MAX_WAIT_S", 0.5)
        started = time.monotonic()
        r = await poll_telegram_now(PollNow(reason="manual", wait_seconds=3600))
        assert r["completed"] is False
        assert time.monotonic() - started < 5


class TestRelayCounter:
    """The counter the wait watches has to be bumped by the relay itself.

    And it has to be bumped right after the initial drain, NOT after the active
    window: that window holds a cycle open for up to five minutes of long polls,
    which is far past any wait a button can hold. Get the order wrong and "Check
    now" times out on a poll that already finished and found the shares.

    This runs the real `run_relay_loop`, with the network call stubbed. The
    stubbed drain parks inside the active window and refuses to return until the
    test has looked at the counter, so a bump moved below the window fails here
    instead of passing on a source string that happens to still match.
    """

    async def test_poll_seq_bumps_before_the_active_window(self, monkeypatch):
        import contextlib

        from backend.core.mesh import pairing
        from backend.services import telegram_relay as tr

        in_window = asyncio.Event()       # the window's drain has been entered
        release_window = asyncio.Event()  # ... and may now return
        calls = 0

        async def fake_drain(client, token, settings, timeout):
            nonlocal calls
            calls += 1
            if calls == 1:
                return True  # activity, which is what opens the active window
            in_window.set()
            await release_window.wait()
            return False

        monkeypatch.setattr(tr, "_drain", fake_drain)
        # The host lock is held by whatever openMemo is already running on this
        # machine, and Mesh's singleton check wants a database.
        monkeypatch.setattr(tr, "relay_disabled_reason", lambda: None)

        async def _yes(_name):
            return True

        monkeypatch.setattr(pairing, "may_run_singleton", _yes)

        task = asyncio.create_task(tr.run_relay_loop())
        try:
            await asyncio.wait_for(in_window.wait(), timeout=5)
            # Inside the active window now. The first drain is done, so the
            # cycle a waiting caller cares about has finished.
            assert RELAY_STATUS["poll_seq"] == 1
        finally:
            release_window.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def test_a_failed_cycle_bumps_it_too(self, monkeypatch):
        """Otherwise "Check now" hangs on exactly the failure worth reporting."""
        import contextlib

        from backend.core.mesh import pairing
        from backend.services import telegram_relay as tr

        async def boom(client, token, settings, timeout):
            raise tr.TelegramUnreachable("no route to host")

        monkeypatch.setattr(tr, "_drain", boom)
        monkeypatch.setattr(tr, "relay_disabled_reason", lambda: None)

        async def _yes(_name):
            return True

        monkeypatch.setattr(pairing, "may_run_singleton", _yes)

        task = asyncio.create_task(tr.run_relay_loop())
        try:
            for _ in range(100):
                if RELAY_STATUS["poll_seq"] == 1:
                    break
                await asyncio.sleep(0.05)
            assert RELAY_STATUS["poll_seq"] == 1
            assert "no route to host" in (RELAY_STATUS["last_error"] or "")
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
