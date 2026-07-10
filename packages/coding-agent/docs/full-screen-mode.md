# Full-screen mode

Full-screen mode is an opt-in interactive Screen mode. Scrollback mode remains the default.

## Start

```bash
pi --full-screen-mode
```

`--full-screen-mode` is interactive-only. Pi rejects it with `-p`, `--mode json`, `--mode rpc`, `--help`, `--version`, `--list-models`, `--export`, and non-TTY stdin/stdout.

## Layout

Full-screen mode splits the interactive UI into two terminal regions:

- **Message viewport**: startup header, conversation history, tool output, notifications, and other transcript content
- **Composer region**: queued messages, status, widgets, editor or replacement UI, and footer

The Composer region stays fixed at the bottom. The Message viewport fills the remaining rows above it. In very small terminals, the Message viewport yields space before the Composer region does.

## Scrolling and follow behavior

- `PageUp` scrolls the Message viewport upward by one page.
- `PageDown` scrolls the Message viewport downward by one page.
- `Ctrl+Down` jumps back to the live bottom.
- Up and Down stay editor-local for cursor movement, autocomplete, and prompt history.

When you scroll up and new content arrives, Pi preserves your historical view and shows a **New content indicator** instead of snapping back to the bottom. Sending a new message returns the Message viewport to the live bottom.

## Configurable actions

Full-screen Message viewport shortcuts use these keybinding action ids:

| Action id | Default |
| --- | --- |
| `app.messageViewport.pageUp` | `PageUp` |
| `app.messageViewport.pageDown` | `PageDown` |
| `app.messageViewport.jumpToBottom` | `Ctrl+Down` |
| `app.messageViewport.scrollUp` | unbound |
| `app.messageViewport.scrollDown` | unbound |

## Mouse scope

Full-screen mode enables terminal mouse reporting by default so wheel and trackpad input can scroll the Message viewport or focused Composer region.

Because terminal mouse reporting prevents ordinary terminal-native drag selection in many terminals, Pi implements its own visible-text selection in Full-screen mode. Drag over visible text to select it; when you release the mouse button, Pi copies the selected text to the system clipboard.

If you need terminal-native selection instead of Pi-owned selection, start Pi with mouse reporting disabled:

```bash
PI_FULL_SCREEN_MOUSE_REPORTING=0 pi --full-screen-mode
```

With mouse reporting disabled, Pi does not handle wheel or trackpad input. Use the keyboard Message viewport actions for history navigation.

Pi does not add:

- click-to-reposition cursor behavior
- keyboard-driven copy mode for hidden history

Terminal-native selection or copy features outside Pi's ownership still depend on your terminal.

## Terminal restoration

While Full-screen mode is active, Pi uses the terminal alternate screen. Exiting Full-screen mode restores the previous terminal view and does not replay the Pi transcript into shell scrollback.

Normal interactive exits, process `SIGINT`, `SIGTERM`, `SIGHUP`, uncaught exceptions, and unhandled rejections route through the terminal restoration path.

The same restoration behavior applies when Pi temporarily releases the terminal:

- `Ctrl+Z` suspends Pi and restores the ordinary terminal view until `fg`
- `Ctrl+G` external editor handoff restores the ordinary terminal view while the editor owns the terminal

When Pi resumes, it redraws the current session in Full-screen mode. Returning from the external editor preserves the current Message viewport position.

## Smoke checklist

- Start `pi --full-screen-mode`.
- Verify the Message viewport is above the fixed Composer region.
- Use `PageUp`, `PageDown`, and `Ctrl+Down`.
- Verify wheel or trackpad input scrolls the Message viewport.
- Drag over visible text, release, and verify the selected text is copied to the clipboard.
- Scroll up, trigger new output, and verify the New content indicator appears without losing your position.
- Optionally rerun with `PI_FULL_SCREEN_MOUSE_REPORTING=0` and verify terminal-native selection plus keyboard Message viewport navigation.
- Exercise representative extension UI: an overlay and a replacement UI if your setup provides them.
- Suspend with `Ctrl+Z`, then resume with `fg`.
- Open the external editor with `Ctrl+G`, return, and confirm the Message viewport position is preserved.
- Exit Pi and confirm the pre-Pi terminal view is restored without the Pi transcript appearing in shell scrollback.
