# Private app builds and public execution

Download an existing ARM64 simulator build using the agent's local GitHub authorization, for example:

```sh
gh run view BUILD_RUN_ID --repo OWNER/PRIVATE_APP --json headSha,conclusion
gh run download BUILD_RUN_ID --repo OWNER/PRIVATE_APP --name SIMULATOR_ARTIFACT --dir /private/build-input
```

Check the build conclusion, exact app commit, artifact checksum when provided, and intended simulator architecture/toolchain. Unpack the trusted app archive locally preserving its `.app` bundle structure and symlinks. Point the harness's `exec ... install BUNDLE_ID APP_PATH` at that local bundle; agent-device uploads it to the live simulator. Private repository credentials stay on the agent host. Do not copy the private source, a private GitHub token, or a private artifact download URL into the public harness repository/workflow inputs.

Read the harness's `docs/privacy.md` at the reviewed commit before first private use. The bootstrap artifact is encrypted to a fresh client key, but the live tunnel uses TLS terminated by Cloudflare. GitHub, Cloudflare, the toolchain, and harness maintainers are in the trust boundary. App data, logs, and captures stay on the runner temporarily and return directly to the client. Use synthetic test credentials/data.

The public repository's standard runner pricing does not settle whether a cross-repository hosted simulator service meets GitHub's associated-project requirement. This harness cannot promise approval or unlimited free private testing. If the project cannot accept that uncertainty or the public-runner trust boundary, run its tests in its private repository; a public reusable workflow is billed to that private caller.

A simulator cannot validate real-device entitlements, Screen Time enforcement, camera/hardware behavior, production push delivery, App Store installation, or portable Keychain/login state. State those limits in the test result when they affect the scenario.
