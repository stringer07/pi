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
- While the built-in editor has ordinary focus, Up and Down can hand off one line at a time to the Message viewport after editor-local movement, autocomplete, and history behavior are exhausted.
- Mouse wheel and trackpad scrolling are routed by pointer location in Full-screen mode:
  - over the Message viewport: scroll transcript history
  - over the built-in editor: scroll editor content

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

Full-screen mode supports wheel and trackpad routing only.

Pi does not add:

- click-to-reposition cursor behavior
- drag selection
- built-in copy mode
- Pi-owned mouse text selection

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
- Scroll up, trigger new output, and verify the New content indicator appears without losing your position.
- Verify wheel or trackpad scrolling over the Message viewport and built-in editor.
- Exercise representative extension UI: an overlay and a replacement UI if your setup provides them.
- Suspend with `Ctrl+Z`, then resume with `fg`.
- Open the external editor with `Ctrl+G`, return, and confirm the Message viewport position is preserved.
- Exit Pi and confirm the pre-Pi terminal view is restored without the Pi transcript appearing in shell scrollback.
