# Auto-update setup (one-time)

This is a **one-time** setup to enable the in-app updater. You only do this
once — the keys you generate stay valid for the lifetime of the app.

Once setup is complete, every release pushed via `release.yml` will be signed
automatically. The app's "Check for updates" button in Settings → About will
then verify those signatures and install updates in-place.

---

## What you need

- nxs source tree checked out locally
- Repo admin access on GitHub (to add secrets)
- A safe place to store the generated private key (password manager works)

## Step 1 — Generate the signing keypair

In a terminal at the repo root:

```powershell
npx @tauri-apps/cli signer generate -w nxs-updater.key
```

You'll be prompted for a passphrase. **Set one — don't leave it empty.** This
passphrase encrypts the private key file at rest. Pick something memorable
but strong (a passphrase manager is ideal).

This creates two files in the current directory:

- `nxs-updater.key` — the **private** key. **Never commit this file.** Keep
  a copy in your password manager or other secure offline storage. If you
  lose it, you'll have to generate a new keypair AND every existing installed
  copy of nxs will be unable to verify updates from the new keypair (users
  would need to reinstall manually from a fresh download).
- `nxs-updater.key.pub` — the **public** key. This goes into `tauri.conf.json`.

## Step 2 — Add the public key to `tauri.conf.json`

Open `src-tauri/tauri.conf.json` and find this block:

```jsonc
"plugins": {
  "updater": {
    "endpoints": [ "..." ],
    "pubkey": "REPLACE_WITH_PUBLIC_KEY_FROM_TAURI_SIGNER_GENERATE",
    "windows": {
      "installMode": "passive"
    }
  }
}
```

Replace the `REPLACE_WITH_…` placeholder with the contents of
`nxs-updater.key.pub`. It's a single base64-encoded line — paste it verbatim
between the quotes.

Then verify it built:

```powershell
cargo check --manifest-path src-tauri\Cargo.toml
```

Commit the change. The `pubkey` is **safe to commit** — it's the public half
of the keypair, by design exposed to clients to verify signatures.

## Step 3 — Add the GitHub Actions secrets

In your GitHub repo:

1. Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add two secrets:

| Secret name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Full contents of `nxs-updater.key` (the file you generated in Step 1, NOT the `.pub` one). Paste with line breaks preserved. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The passphrase you set in Step 1. |

After saving, these secrets are write-only — GitHub can read them in your
workflows but never displays them again. If you lose the local copy, you'd
have to regenerate.

## Step 4 — Tag a new release and watch the workflow

```powershell
git tag -a v0.1.14 -m "Release v0.1.14"
git push origin v0.1.14
```

In the Actions tab, the release workflow runs. Confirm:

- The "Build Tauri app" step succeeds (signing happens inside this step)
- The "Generate latest.json manifest" step shows `skipped=false` and prints
  the manifest contents
- The published GitHub Release has 3 assets:
  - `nxs_0.1.14_x64_en-US.msi`
  - `nxs_0.1.14_x64-setup.exe`
  - `latest.json`  ← **this is the new one**

If `latest.json` is missing, signing didn't happen — re-check Step 3.

## Step 5 — Test the in-app updater

1. Install the **previous** release (v0.1.13) — the one without the updater
   integration. Or install v0.1.14 then publish v0.1.15 to test the upgrade.
2. Open nxs → Settings → About → "Updates" section
3. Click "Check for updates"
4. If a newer version is available, the UI shows version + notes + "Install
   now" button
5. Click install → progress bar → app relaunches into new version

## What can go wrong

| Symptom | Cause | Fix |
|---|---|---|
| "Update check failed: error sending request" | Manifest endpoint not reachable | Check `endpoints` URL in `tauri.conf.json`; verify `latest.json` is published as a release asset |
| "Signature verification failed" | Private key used to sign ≠ public key in the binary | Regenerate keypair, re-set secrets, re-tag a release |
| Updater check returns null | Current version >= manifest version (no update available) | This is correct behaviour — bump version and tag a new release |
| `latest.json` missing from release | Secrets not configured or build failed | Check Actions logs for the "Generate latest.json manifest" step |
| App finds the update but the install hangs | NSIS installer requires elevation that's being blocked | Run nxs as admin once, or check Windows Defender / SmartScreen |

## Re-keying (lost private key or rotation)

If you lose `nxs-updater.key` or want to rotate:

1. Generate new keypair (Step 1 again)
2. Update `tauri.conf.json` with the new public key
3. Replace the two GitHub secrets
4. Bump version and tag a new release

**Existing installed copies** still have the OLD public key embedded. They
will REJECT updates signed by the new private key (this is the security
guarantee). Affected users need to download and reinstall manually from
the GitHub release page. There's no way around this — it's how signature
verification works.

For this reason: **keep the private key safe**. It's the single most
important secret in this project once the updater is live.
