# Security Policy

down-detector handles Twilio credentials (as Worker secrets) and sends
outbound notifications. We appreciate responsible disclosure.

## Supported versions

| Version | Supported          |
|---------|--------------------|
| 1.x     | :white_check_mark: |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's built-in vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, affected version, and reproduction steps.

You'll get an acknowledgment within a few days. Once a fix ships, we'll credit
you in the release notes unless you'd rather stay anonymous.

## Notes for deployers

- `wrangler.jsonc` is gitignored for a reason — it holds your phone numbers,
  check URLs, and webhook URL. Keep it out of version control.
- `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` belong in Worker secrets
  (`wrangler secret put`), never in `vars`.
- A Slack/Discord webhook URL is itself a credential — anyone holding it can
  post to your channel. Treat `WEBHOOK_URL` accordingly.
