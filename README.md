# brine-sandbox

Run the [Pi](https://pi.dev) coding agent on your own machine against SHARCNET's Brine models, inside a [nono](https://github.com/nolabs-ai/nono) sandbox. The agent can work in your project directory and talk to Brine. It can't read the rest of your files, it can't reach the rest of the internet, and it never sees your real Brine key.

Short version of when to use it: it's for "I want an agent on my laptop and I don't want it leaking my SSH keys or my data anywhere". It's not for sensitive data. For that, consider [brine-secure](https://github.com/sharcnet/brine-secure).

## Setup

You need Linux with kernel 6.7 or newer, Node.js, and curl. [Platforms](#platforms) has the details.

1. **Install nono 0.82.0.** Download the release binary for your platform from the [v0.82.0 release](https://github.com/nolabs-ai/nono/releases/tag/v0.82.0), check it against the release's `SHA256SUMS.txt`, and put it on your `PATH` as `nono`. The launcher refuses any other version. [Upgrading nono](#upgrading-nono) covers moving to a new one.
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
5. **Run the probes once** from any project directory. Every line has to say PASS before you trust it on this machine:
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

Any arguments go straight to Pi. On each start the launcher asks Brine for its current model list, so new models show up on their own. The default is `Qwen3.8-27B`, and whatever you pick with `/model` sticks.

Pi's config and session history live in `~/.local/state/brine-sandbox/pi/`, not your normal `~/.pi`, so the agent can't reach your other Pi setup or the logins in `~/.pi/agent/auth.json`.

The launcher won't start in your home directory, in `/`, or in any directory that contains this repo or `~/.config/brine-sandbox`. Those would hand the agent your key or its own policy.

## How it works

| File | What it does |
|---|---|
| `brine-sandbox` | Launcher. Checks the nono version, finds Pi, fills your key's path into the profile, and starts Pi under nono with read/write on the current directory only |
| `profile.json` | The nono policy. Extends nono's `default` profile, which already blocks SSH keys, cloud credentials and shell configs, and adds the Brine route |
| `setup-pi.mjs` | Runs inside the sandbox right before Pi. Fetches the model list through nono and writes Pi's `models.json` |
| `probes.sh` | Escape tests, run by `brine-sandbox --check` inside the same sandbox Pi gets |

nono applies Landlock and seccomp to the agent process and starts a local proxy. The agent's only way out is that proxy, and the only destination the proxy knows is `https://brine.sharcnet.ca/v1`. When a request comes through, nono swaps the agent's per-session token for your real key and forwards it, but only for `POST /chat/completions` and `GET /models`.

## Security mitigations

Each row is something a misbehaving agent might try, what blocks it, and the `brine-sandbox --check` probe that tests it on your machine. You don't have to take this table's word for it.

| Threat | Mitigation | Probe |
|---|---|---|
| Agent sends your code or data to some random server | Proxy-only networking. Direct connections, DNS and UDP are blocked, and the proxy refuses every host except Brine | internet via proxy / direct, DNS lookup, UDP |
| Agent exfiltrates through the Plausible Analytics site that shares Brine's IP, which is brine-secure's main open issue | Only the hostname route to Brine exists. Connecting by IP is refused, and nono terminates TLS for Brine and rewrites `Host`, so domain fronting doesn't reach Plausible either | plausible vhost by IP, fronting |
| Agent steals your Brine key | The key never enters the sandbox. The agent gets a per-session token that only works against nono's proxy, and the key file is unreadable inside | read the real Brine key, CONNECT brine carries no key, without session token |
| Agent uses your key for more than chat, like minting new keys | Endpoint rules allow only `POST /chat/completions` and `GET /models`. `/key/*` and `../` tricks get 403 | POST /key/generate, ../ traversal |
| Agent reads your SSH keys, cloud credentials, or other projects | The agent can write the current directory and Pi's state dir, and read Pi's install. Your home directory isn't even listable | read ~/.ssh, list home directory |
| Agent grabs your other AI provider logins | Pi runs with its own config dir, so `~/.pi/agent/auth.json` is out of reach | read ~/.pi/agent/auth.json |
| Agent loosens its own sandbox for next time | The generated policy and this repo are read-only to the agent, and the launcher refuses to run where they'd be writable | rewrite the sandbox policy, rewrite the launcher |
| Agent drops something in your home dir, like a `.bashrc` line | No write access outside the project directory, apart from `/tmp`, which is covered below | write to home directory |
| Agent reads the key out of nono's memory or environment | The agent can't signal processes outside the sandbox or read their `/proc/*/environ` | read nono supervisor environ |
| A nono upgrade quietly changes behaviour | The launcher pins nono 0.82.0 and won't run with anything else until the probes pass again | n/a |

In nono 0.82.0 an empty `allow_domain` list leaves the network fully open, even with a credential route set up. The first pilot run reached example.com because of this. That's why `profile.json` allows `nono.invalid`, a domain that can't exist. Don't remove it.

### What it doesn't protect against

- **Anything the agent writes in your project runs as you later.** It can edit `.git/hooks`, a `Makefile`, `.envrc`, a `.venv`, your test suite. Those run outside the sandbox the next time you or your editor touch them. Review the diff before you run things, same as you would for a stranger's pull request.
- **Prompt injection.** A README, a pasted issue or a downloaded dataset can carry instructions Pi might follow. The sandbox limits the damage but doesn't stop Pi from following them.
- **Brine sees what Pi reads.** Everything the agent opens can end up in a request to Brine, including `.env` files in your project. Brine runs on SHARCNET hardware and doesn't forward to outside providers, but Brine's terms still say not to send sensitive data.
- **`/tmp` is shared and writable.** nono's default profile grants it. Don't keep secrets there, and be careful with any `PATH` entry under `/tmp`.
- **No PID or network namespace.** The agent can see your process list, though it can't read other processes' environment or memory.
- **Shared kernel.** This is a sandbox on your own kernel, not a VM. A kernel bug or a nono bug could break it. That's the trust question below.

## Trusting nono

The agent is untrusted. It's a model generating commands as it goes, steered by whatever text ends up in front of it, so brine-sandbox doesn't rely on it behaving well. It contains it instead.

Containment is software too, and that software has to be trusted. No setup removes trust entirely. The real question is which software to trust and whether that's a reasonable bet. brine-sandbox trusts:

- **The Linux kernel**, for Landlock and seccomp. It's already trusted with everything else on the machine.
- **nono.** It enforces the filesystem rules, runs the proxy, and holds the Brine key. If nono is wrong, the sandbox is wrong.
- **This repo.** Under 200 lines of shell, JSON and JavaScript, short enough to read in full.
- **Brine and SHARCNET**, with whatever the agent sends them.

A sandbox with a filtering, key-injecting proxy is exactly what nono is. Rebuilding it on bubblewrap would mean more custom code to trust, not less. nono is a single open source binary, and the rules it applies are in `profile.json`.

That trust has limits:

- **The version is pinned.** Upgrades happen on purpose, after the probes pass.
- **Behaviour is tested, not the documentation.** The probes try to break out and check that they fail. They've already caught real gaps. The empty-`allow_domain` behaviour above isn't documented, the docs on nono's `main` branch describe features 0.82.0 doesn't have, and a probe found that Landlock lets the agent change timestamps on files it can't write to.
- **The trusted part stays small.** No layer gets added unless a probe shows it's needed.

nono is pre-1.0 and releases about every two weeks, so this is still a bet. It's a far better one than the common alternative, an agent running with your full user account.

## Upgrading nono

1. Install the new nono release and verify its checksum, same as in setup.
2. Change `NONO_VERSION` at the top of `brine-sandbox`.
3. Run `brine-sandbox --check`. Every line must PASS. Read the release notes for anything touching networking, credentials or Landlock.
4. Only then commit the version bump.

## Platforms

- **Linux**: tested on Ubuntu 24.04, kernel 7.0. nono needs Landlock ABI v4, so kernel 6.7 or newer, to restrict TCP. Run `brine-sandbox --check` on any new machine, and don't use it there if a network probe fails.
- **macOS**: nono uses Seatbelt there instead of Landlock. Not tested yet, and `probes.sh` still needs porting.
- **WSL2**: nono doesn't enforce network rules there. Don't use it.
- **Nibi login nodes**: not tested. The kernel is older than 6.7, so expect the network probes to fail.
