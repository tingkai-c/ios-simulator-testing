# Validation

This is a prototype, not a production security assurance.

Local protocol, client validation, host selection, HTTP authentication/proxy, and fixture tests run with:

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

The current regression suite has 24 Node tests and 10 Python tests. The skill frontmatter and references pass Codex's skill-creator validator and an independent read-only skill scenario. Those checks cannot prove native iOS behavior.

The manual **Synthetic native smoke** workflow compiles a tiny public UIKit demo and validates the encrypted bootstrap, authenticated app upload, accessibility interaction, screenshot, fixture export/import, and shutdown. Its synthetic client uses the host’s loopback gateway to isolate fixture correctness from Quick Tunnel availability. Cloud transport is verified separately from a Linux agent. It uses synthetic state only and uploads no private captures or raw host diagnostics.

- [Public transport preflight](https://github.com/tingkai-c/ios-simulator-testing/actions/runs/43082413556) passed after adding the scoped DNS fallback. Earlier macOS system lookups returned `ENOTFOUND` despite a connected tunnel.
- [Linux agent live session](https://github.com/tingkai-c/ios-simulator-testing/actions/runs/43082555402) completed successfully: dispatch at a reviewed SHA, encrypted bootstrap download/decryption, proxy connection, opening Settings, accessibility snapshot, tapping General, screenshot download, shutdown, and completed-job verification. Screenshot inspection confirmed General was displayed. Label-only assertions encountered normal ambiguous matches in Settings; use fresh refs or narrower role/identifier selectors.
- [Synthetic native smoke](https://github.com/tingkai-c/ios-simulator-testing/actions/runs/43082424584) uploaded its app, then failed during UI interaction. Later runs isolated an Xcode destination failure for iOS 26.5. The upstream-tested iOS 26.2 runtime passed upload, initial counter assertions, tapping, and app-data export; a subsequent 10-second UI wait expired while XCTest restarted after the fixture reboot. The corrected smoke allows 120 seconds for that readiness phase. Complete import/restore verification is still pending.

Follow-up validation has not established reliable fixture restoration: the [loopback smoke](https://github.com/tingkai-c/ios-simulator-testing/actions/runs/43093925840) failed its native test step. The [latest Linux session](https://github.com/tingkai-c/ios-simulator-testing/actions/runs/43094339986) reached simulator readiness, but encrypted bootstrap artifact publication stalled before the client could connect. Both runs received cancellation requests. Treat session provisioning as experimental and full app-data import/restore as unverified.

Cold setup took about five minutes in these runs; the first app open took roughly another minute, with later snapshots and taps taking seconds. This is a small sample, not a latency guarantee.

Separate validation is needed for actual private apps, preview Xcode images, real-device features, and any GitHub permission for a general cross-repo service. No private app or private fixture has been uploaded during validation.
