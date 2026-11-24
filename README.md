# brine-sandbox

Run the [Pi](https://pi.dev) coding agent on your own machine against SHARCNET's Brine models, inside a [nono](https://github.com/nolabs-ai/nono) sandbox. The agent can work in your project directory and talk to Brine. It can't read the rest of your files, it can't reach the rest of the internet or your desktop session, and it never sees your real Brine key.

Short version of when to use it: it's for "I want an agent on my laptop and I don't want it leaking my SSH keys or my data anywhere". It's not for sensitive data. For that, consider [brine-secure](https://github.com/sharcnet/brine-secure).

## Setup

You need Linux with kernel 6.7 or newer, Node.js, and curl. [Platforms](#platforms) has the details.

1. **Install nono 0.82.0.** Download the release tarball for your platform from the [v0.82.0 release](https://github.com/nolabs-ai/nono/releases/tag/v0.82.0) and check where it came from:
   ```
   gh attestation verify nono-v0.82.0-x86_64-unknown-linux-gnu.tar.gz --repo nolabs-ai/nono
   ```
   That checks GitHub's signed build provenance for the release workflow, and needs `gh` 2.49 or newer. nono doesn't publish detached signatures, and the release's `SHA256SUMS.txt` sits next to the files it describes, so it only catches a broken download. Extract `nono` from the tarball and put it on your `PATH`. The launcher refuses any binary whose sha256 isn't one of the pinned tarball builds, so the release's `.deb` and `.rpm` packages aren't supported. [Upgrading nono](#upgrading-nono) covers moving to a new one.
2. **Install Pi** from <https://pi.dev>. The managed installer and an npm global install both work.
3. **Get this repo and put the launcher on your PATH:**
   ```
   git clone https://github.com/sharcnet/brine-sandbox.git
   ln -s "$PWD/brine-sandbox/brine-sandbox" ~/.local/bin/
   ```
4. **Save your Brine API key** where only you can read it:
   ```
   mkdir -p ~/.config/brine-sandbox
   install -m 600 /dev/null ~/.config/brine-sandbox/brine.key
   $EDITOR ~/.config/brine-sandbox/brine.key
   ```
5. **Run the checks once** from any project directory. It has to end with `All clear.` before you trust it on this machine:
   ```
   cd ~/some-project
   brine-sandbox --check
   ```

## Usage

```
cd ~/some-project
brine-sandbox                 # interactive Pi
brine-sandbox -p "..."        # one-shot
```

Any arguments go straight to Pi. On each start Pi asks Brine for its current model list, so new models show up on their own. The default is `Qwen3.8-27B`, and whatever you pick with `/model` sticks for that project.

Each project gets its own Pi history, settings and extensions under `~/.local/state/brine-sandbox/projects/`, keyed by the project's path. The agent in one project can't read another project's transcripts or plant extensions for it, and it can't reach your normal `~/.pi` or the logins in `~/.pi/agent/auth.json`. Older versions kept one shared `~/.local/state/brine-sandbox/pi/`. Delete it once you don't need its history.

The launcher won't start in `/`, in your home directory or any directory above it, or in any directory that contains (or sits inside) this repo, `~/.config/brine-sandbox`, Brine-sandbox's state, the nono binary, or the file your key actually lives in. Paths are resolved first, so a symlinked key, home or XDG directory doesn't get around this. Each of those would hand the agent your key, its own policy, or another project's state.

If Pi changed your project's Git config or hooks during the session, the launcher says so when Pi exits and waits for Enter. See [What it doesn't protect against](#what-it-doesnt-protect-against).

## How it works

| File | What it does |
|---|---|
| `brine-sandbox` | Launcher. Checks the nono binary's digest, resolves and guards paths, fills your key's path into the profile, starts nono from an empty environment with read/write on the current directory and that project's Pi state only, and watches Git config and hooks |
| `profile.json` | The nono policy. Extends nono's `default` profile, which already blocks SSH keys, cloud credentials and shell configs, turns on AF_UNIX socket mediation, and adds the Brine route |
| `brine-provider.mjs` | A Pi extension, loaded read-only from this repo. Fetches the model list through nono and registers Brine in memory, so concurrent launches don't share a `models.json` |
| `checks.mjs` | The escape checks behind `brine-sandbox --check`, plus the live fixtures they run against |

nono applies Landlock and seccomp to the agent process and starts a local proxy. The agent's only way out is that proxy, and the only destination the proxy knows is `https://brine.sharcnet.ca/v1`. When a request comes through, nono swaps the agent's per-session token for your real key and forwards it, but only for `POST /chat/completions` and `GET /models`.

nono starts from `env -i` plus a short allowlist (`HOME`, `PATH`, `TERM`, `LANG`, `COLORTERM` and Pi's own settings), so your shell's tokens and any `NONO_*` variables never reach nono or the agent. nono also gets a private `XDG_CONFIG_HOME`, so a user profile named `default` can't replace the built-in one this policy extends. It runs with `--strict-broker-path`, which refuses to start if the sandbox could write to a directory on `PATH`. The launcher drops `PATH` entries under `/tmp` first, since the sandbox can't read them anyway.

## Checking it

`brine-sandbox --check` runs every probe three times:

1. **Outside the sandbox.** Every probe has to reach its target. That proves the probe can tell access from denial on this machine, rather than passing because a file is missing or a tool isn't installed.
2. **In the sandbox Pi gets,** with dummy credentials and widening `NONO_*` variables set in the launcher's environment. Every probe has to see a denial it can attribute: an `EACCES` or `EPERM` from the kernel, or a response that identifies nono as the one refusing (nono's denials have no `Server` header and a fixed body; Brine's come from nginx). An HTTP status alone only proves something answered, and a timeout proves nothing, so neither counts.
3. **In a sandbox with a fixture secret and socket granted on purpose.** Both probes have to catch it, so a grant that slips in later can't pass unnoticed.

The probes run against live fixtures the launcher starts outside the sandbox: Unix, abstract, TCP and UDP receivers that log every connection, a canary credential in Brine-sandbox's state, in `/tmp` and in a fake second project, and your real session bus, SSH agent and display sockets when they exist. A receiver hearing from inside the sandbox fails the run. Probes never print what they read. They compare contents to the canary's hash, and the run fails if the canary shows up in any output.

Anything inconclusive (`????`) blocks the all-clear. Host sockets and files that don't exist on your machine are skipped, since the fixtures already test the mechanism behind them. The run ends with the kernel and nono versions, the Landlock ABI nono enforces, and the effective grants Pi would get in that directory.

## Security mitigations

Each row is something a misbehaving agent might try, what blocks it, and the `--check` probes that test it on your machine. You don't have to take this table's word for it.

| Threat | Mitigation | Probes |
|---|---|---|
| Agent sends your code or data to some random server | Proxy-only networking. Direct TCP and UDP are blocked, and the proxy refuses every host except Brine | internet through the proxy, direct TCP to Brine's IP, TCP and UDP to localhost receivers |
| Agent exfiltrates through the Plausible Analytics site that shares Brine's IP, which is brine-secure's main open issue | Only the hostname route to Brine exists. Connecting by IP is refused, and nono terminates TLS for Brine, so `Host: x` reaches Brine rather than Plausible | Plausible vhost by IP, fronting |
| Agent uses your desktop session: D-Bus services, SSH agent, Wayland or X11 | nono's pathname AF_UNIX mediation denies `connect` and `bind` on every Unix socket the profile doesn't list. The `default` profile lists only `/run/systemd/userdb`, for user and group lookups. Landlock scopes abstract sockets and signals | Unix socket fixture, session bus, SSH agent, Wayland, X11, abstract socket fixture, signal |
| Agent steals your Brine key | The key never enters the sandbox. The agent gets a per-session token that only works against nono's proxy, and the key file is unreadable inside. Tunnelling to Brine's hostname directly works, but nono doesn't inject the key there | read the real Brine key, CONNECT to Brine's host carries no key, route without the session token |
| Agent uses your key for more than chat, like minting new keys | Endpoint rules allow only `POST /chat/completions` and `GET /models`. Everything else, including `../`, `%2e%2e`, `%2f`, double-encoded and `..;` paths, gets nono's 403 | the `Brine route:` probes |
| Agent reads your SSH keys, cloud credentials, other projects or other Pi sessions | The agent can write the current directory and its own project's Pi state, and read Pi's install. Your home directory isn't even listable | read a dummy credential, list ~/.ssh, list home directory, another project's Pi session and extensions |
| Agent grabs your other AI provider logins | Pi runs with its own per-project config dir, so `~/.pi/agent/auth.json` is out of reach | read ~/.pi/agent/auth.json |
| Agent picks up credentials or sandbox settings from your shell | nono starts from an empty environment plus an allowlist | dummy host credentials in the environment; `NONO_ALLOW` and `NONO_ALLOW_DOMAIN` are set during the run and the fixture and example.com probes must still pass |
| Agent loosens its own sandbox for next time | The generated policy, this repo and nono are read-only to the agent, and the launcher refuses to run where they'd be writable | rewrite the sandbox policy, rewrite the launcher |
| Agent drops something in your home dir, like a `.bashrc` line | No write access outside the project directory and its Pi state, apart from `/tmp`, which is covered below | write to home directory |
| Agent reads the key out of nono's memory or environment | The agent can't signal processes outside the sandbox or read their `/proc/*/environ` | read the nono supervisor's environment |
| A different or tampered nono runs instead | The launcher resolves nono to an absolute path and refuses it unless its sha256 matches a pinned 0.82.0 release build | n/a |

In nono 0.82.0 an empty `allow_domain` list leaves the network fully open, even with a credential route set up. The first pilot run reached example.com because of this. That's why `profile.json` allows `nono.invalid`, a domain that can't exist. Don't remove it.

### What it doesn't protect against

- **Anything the agent writes in your project runs as you later.** It can edit `.git/config`, `.git/hooks`, a `Makefile`, `.envrc`, a `.venv`, your test suite. Those run outside the sandbox the next time you or your tools touch them. Git is the sharpest case: a line like `core.fsmonitor` in `.git/config` runs a command whenever anything calls `git status`, and many shell prompts do that as soon as you're back at the prompt. The launcher compares Git config and hooks (including nested repos and `.git` files) before and after the session, lists what changed, and waits for Enter so you can look from another terminal first. It doesn't cover anything else the agent writes. Review the diff before you run things, same as you would for a stranger's pull request.
- **Tools that run while Pi is running.** An editor's Git integration or a shell prompt in another terminal sitting in the same project can run a planted config or hook before the exit warning ever appears. Close them, or point them elsewhere, while the agent works.
- **Prompt injection.** A README, a pasted issue or a downloaded dataset can carry instructions Pi might follow. The sandbox limits the damage but doesn't stop Pi from following them.
- **Brine sees what Pi reads.** Everything the agent opens can end up in a request to Brine, including `.env` files in your project. Brine runs on SHARCNET hardware and doesn't forward to outside providers, but Brine's terms still say not to send sensitive data.
- **`/tmp` is shared and writable.** nono's default profile grants write-only access. The agent can't list `/tmp` or read other files there, but it can create files. Be careful with any `PATH` entry under `/tmp` in your own shell.
- **No PID or network namespace.** The agent can see your process list, including other processes' command-line arguments, though not their environment or memory. Don't pass secrets on command lines while it runs.
- **Shared kernel.** This is a sandbox on your own kernel, not a VM. A kernel bug or a nono bug could break it. That's the trust question below.

### Open question: upstream redirection

nono only lets `POST /chat/completions` through, but it doesn't look at the request body. If Brine honours client-supplied options that change where it sends a request (LiteLLM's `api_base` is the usual example), the agent could point Brine at a server of its choosing. We haven't confirmed Brine's behaviour with its administrators yet, so there's no check for it. Once the behaviour is agreed, it gets a controlled regression check in `checks.mjs`.

## Trusting nono

The agent is untrusted. It's a model generating commands as it goes, steered by whatever text ends up in front of it, so brine-sandbox doesn't rely on it behaving well. It contains it instead.

Containment is software too, and that software has to be trusted. No setup removes trust entirely. The real question is which software to trust and whether that's a reasonable bet. brine-sandbox trusts:

- **The Linux kernel**, for Landlock and seccomp. It's already trusted with everything else on the machine.
- **nono.** It enforces the filesystem and socket rules, runs the proxy, and holds the Brine key. If nono is wrong, the sandbox is wrong.
- **This repo.** A few hundred lines of shell, JSON and JavaScript, short enough to read in full.
- **Brine and SHARCNET**, with whatever the agent sends them.

A sandbox with a filtering, key-injecting proxy is exactly what nono is. Rebuilding it on bubblewrap would mean more custom code to trust, not less. nono is a single open source binary, and the rules it applies are in `profile.json`.

That trust has limits:

- **The binary is pinned.** The launcher checks nono's digest, not just its version string, and upgrades happen on purpose, after the checks pass. The digest pin only proves you're running what this repo was tested with. Where that binary came from rests on GitHub's build provenance, which is why setup verifies the attestation.
- **Behaviour is tested, not the documentation.** The checks try to break out and require specific evidence that they failed. They've already caught real gaps. The empty-`allow_domain` behaviour above isn't documented, the docs on nono's `main` branch describe features 0.82.0 doesn't have, a probe found that Landlock lets the agent change timestamps on files it can't write to, and the first review found the desktop session reachable over Unix sockets.
- **The trusted part stays small.** No layer gets added unless a check shows it's needed.

nono is pre-1.0 and releases about every two weeks, so this is still a bet. It's a far better one than the common alternative, an agent running with your full user account.

## Upgrading nono

1. Download the new release, verify its attestation as in setup, and install it.
2. Change `NONO_VERSION` at the top of `brine-sandbox`, and replace `NONO_SHA256` with the sha256 of the `nono` binary from each Linux tarball (`sha256sum nono` after extracting, not the tarball's own sum).
3. Run `brine-sandbox --check`. It must end with `All clear.` Read the release notes for anything touching networking, credentials, Unix sockets or Landlock.
4. Only then commit the bump.

## Platforms

- **Linux**: tested on Ubuntu 24.04, kernel 7.0, where nono reports Landlock V8 and enforces V6. nono needs Landlock ABI v4, so kernel 6.7 or newer, to restrict TCP. Run `brine-sandbox --check` on any new machine, and don't use it there unless it ends with `All clear.`
- **macOS**: nono uses Seatbelt there instead of Landlock. Not tested yet, and `checks.mjs` assumes Linux.
- **WSL2**: nono doesn't enforce network rules there. Don't use it.
- **Nibi login nodes**: not tested. The kernel is older than 6.7, so expect the network checks to fail.
