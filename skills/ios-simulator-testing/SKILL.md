---
name: ios-simulator-testing
description: Test an iOS simulator app through a temporary GitHub macOS session with live screen inspection, interactions, assertions, and app-data fixtures. Use from Linux or other agent hosts without a local iOS simulator.
---

# Live iOS simulator testing

Use the bundled command helper for session lifecycle and privacy; use its `exec` command for pinned agent-device controls. Resolve `SKILL_DIR` to this skill's directory and `SIM="$SKILL_DIR/scripts/simulator.mjs"`. Every session gets a distinct private state directory and one simulator. Serialize commands within it.

## Prepare

Read [references/private-apps.md](references/private-apps.md) when sourcing a build from a private repository or deciding whether public execution fits the project's trust boundary. Public macOS minutes are not a guarantee that GitHub permits arbitrary cross-repository workloads. Private app compilation may still require private minutes.

Require Node 24+, `gh` with workflow dispatch/cancel access to the harness repo, and the skill's pinned dependency (`bun install --cwd "$SKILL_DIR" --frozen-lockfile`). Obtain a trusted simulator `.app` for ARM64; signed device/TestFlight IPAs are a different target. Reuse the app's existing build process.

Select a reviewed commit in `tingkai-c/ios-simulator-testing` and a branch/tag pointing to it. Read the harness repository’s `docs/validation.md` at that commit for verified capabilities and remaining gaps. Never pass private source credentials, artifact URLs, app data, or test names as public workflow inputs. The helper supplies only a random session ID and public encryption key.

## Allocate and connect

```sh
node "$SIM" start --repo tingkai-c/ios-simulator-testing --ref main --sha REVIEWED_FULL_SHA
```

Save `stateFile` from the JSON result as `STATE`. Default is `macos-latest` with iOS 26.2, matching the driver’s upstream CI. Select another installed version with `--ios-version VERSION`, or `newest`; a missing or mismatched version fails explicitly. Choose `--runner xcode-27` when the app needs that toolchain and select its required runtime. Start waits for an encrypted connection bundle and validates the run identity. A readiness timeout triggers cancellation; use the printed private session path with `status`/`stop` before allocating another job.

Session state contains credentials: keep it outside repositories and shared artifacts. Read the helper's `--help` for the small lifecycle surface; keep tokens out of tool arguments, chat, and logs. Every command below uses `node "$SIM" exec --state "$STATE" --` as its prefix.

If GitHub reports `startup_failure` without jobs, inspect the run summary's Annotations; no simulator commands have run. An empty job list or missing logs alone does not identify the cause. For an explicit transient GitHub error, allow one fresh `start` with a new session/keypair after confirming the failed run is completed. Do not rerun another agent's workflow with its old recipient key; you need its matching local private key to decrypt that bootstrap. Stop repeated allocation if the error persists and report the run URL and GitHub request ID.

## Observe, act, verify

```sh
node "$SIM" exec --state "$STATE" -- install com.example.app /private/path/MyApp.app
node "$SIM" exec --state "$STATE" -- open com.example.app
node "$SIM" exec --state "$STATE" -- snapshot -i
node "$SIM" exec --state "$STATE" -- click @e1
node "$SIM" exec --state "$STATE" -- wait 'label="Expected result"' 10000
node "$SIM" exec --state "$STATE" -- is visible 'label="Expected result"'
node "$SIM" exec --state "$STATE" -- screenshot /private/evidence/result.png
```

Derive refs from a fresh snapshot; refresh them after navigation, mutations, or fixture changes. If a selector is ambiguous, narrow it by role/identifier or use a fresh ref. Prefer accessible refs/selectors; use `press x y` with screenshot evidence when necessary. `fill @ref "synthetic text"` enters text. Consult `"$SKILL_DIR/node_modules/.bin/agent-device" help COMMAND` when command details differ.

A successful tap proves dispatch only. Check the intended UI or app behavior and preserve local evidence. For unexpected behavior, inspect a new snapshot and app logs before retrying the mutation. Distinguish app assertion failures from lost/expired sessions and unsupported simulator capabilities. Stop retries when the session expires; report the remaining validation gap.

## Load or save app data

For container fixtures, use:

```sh
node "$SIM" state-export --state "$STATE" --bundle com.example.app --out /private/fixtures/before.zip
node "$SIM" state-import --state "$STATE" --bundle com.example.app --file /private/fixtures/scenario.zip
node "$SIM" exec --state "$STATE" -- open com.example.app
node "$SIM" exec --state "$STATE" -- snapshot -i --timeout 120000
```

The helper closes the active device-control session and the host stops the simulator during transfer; the cloud job stays allocated. After reboot, allow up to 120 seconds for the first UI capture or wait while XCTest restarts; later controls can use normal timeouts. Import replaces `Documents` and `Library`; export first if existing state matters. Use a matching app build/runtime and the same bundle ID. Keychain, shared App Groups, push tokens, and remote backend state need separate app-specific setup. Prefer app-provided test seed/import hooks for versioned logical fixtures. A UI snapshot does not save app data.

## Finish

Always request shutdown, including after assertions fail:

```sh
node "$SIM" stop --state "$STATE"
node "$SIM" status --state "$STATE"
```

`stopRequested` means shutdown was requested. Poll `status` for up to two minutes; if the job still runs, cancel that exact `runId` with `gh run cancel RUN_ID --repo tingkai-c/ios-simulator-testing` and verify completion. Report cleanup uncertainty if GitHub is unavailable. The absolute host lifetime is a fallback, not the normal cleanup mechanism. Report the tested app build/ref, run URL, scenario/assertion results, local evidence paths, and any device-only or untested behavior. Keep private screenshots, fixtures, UI text, and app diagnostics local unless the user authorizes their destination.

If status remains queued/in progress while cancel/force-cancel returns HTTP 409 or says the run is completed, report the inconsistent state and exact run URL; do not keep allocating replacements. GitHub documents [stuck or out-of-sync workflow runs](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#canceling-workflows) that may require Support to clear.
