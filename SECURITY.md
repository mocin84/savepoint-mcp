# Security policy

## Reporting a vulnerability

Please do not report security issues in public issues or discussions. Use GitHub's private vulnerability reporting for this repository if it is enabled. Otherwise, contact the maintainer through the GitHub profile and ask for a private reporting channel.

Include the affected version or commit, impact, and reproducible steps. Avoid including real project codes, access keys, download tokens, or customer data in reports.

## Supported versions

Security fixes are currently made against the latest released version on the default branch. Older deployments may not receive fixes automatically; operators must review updates and redeploy.

## Deployment security notes

- Configure `ACCESS_KEY` as a Wrangler secret. Do not commit it or put it in a public URL.
- Treat project codes and download links as bearer credentials.
- Rotate the access key if it may have been exposed.
- Review Cloudflare account permissions, quotas, and data retention settings before deployment.
