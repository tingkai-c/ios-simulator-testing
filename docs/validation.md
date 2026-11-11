# Validation

This is a prototype, not a production security assurance.

Local protocol, client validation, host selection, HTTP authentication/proxy, and fixture tests run with:

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

The skill frontmatter and references are checked with Codex's skill-creator validator and an independent read-only skill scenario. Those checks cannot prove native iOS behavior.

The manual **Synthetic native smoke** workflow compiles a tiny public UIKit demo and exercises the encrypted bootstrap, Cloudflare tunnel, remote app upload, accessibility interaction, screenshot, fixture export/import, and shutdown. It uses synthetic state only and uploads no private captures or raw host diagnostics.

Native smoke has not yet completed. Update this file with the exact workflow run and outcome before claiming the live cloud path works. Separate validation is needed for dispatch/readiness/cancel from an agent host, actual private apps, preview Xcode images, real-device features, and any GitHub permission for a general cross-repo service.
