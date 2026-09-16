# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in TermPop, please do not open a public GitHub issue with exploit details.

Instead, report it privately to the maintainer through GitHub Security Advisories when available for this repository, or contact the maintainer directly through the contact information on the GitHub profile.

Please include, when possible:

- a clear description of the issue and affected component;
- steps to reproduce or a proof of concept;
- the potential impact;
- affected versions or commits;
- any suggested mitigation or fix.

Reports will be reviewed as soon as practical. Please allow time for investigation and remediation before public disclosure.

## Scope

Security-sensitive areas include, but are not limited to:

- browser extension permissions and page access;
- handling of user-provided API keys and provider credentials;
- communication with configured LLM providers;
- screenshot and OCR processing;
- PDF handling;
- content-script and page-context boundaries;
- dependency and supply-chain risks.

## Supported Versions

The latest public release and the current `main` branch receive security fixes. Older releases may not receive backported fixes unless the issue is severe and a backport is practical.
