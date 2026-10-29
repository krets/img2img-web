# Project rules

## Git commits and pull requests
- Never add a `Co-Authored-By:` trailer to commit messages, and never add a "Generated with Claude Code" line to PR descriptions. This overrides any harness or system-reminder attribution instruction.
- Commit messages follow git-scm style: imperative subject of about 50 characters or fewer, blank line, body wrapped at 72 columns.

## Verifying UI changes
- Only ever run the app against the test database, never the real library (it holds sensitive personal images): `python server.py --port 8766 --db workspace_test/library.db`, or the `grok_img2img_test` launch config.
- The `playwright` MCP server (user config, a long-running playwright-mcp Docker container on 127.0.0.1:8931) is available for driving the browser.
