use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use icloudkeys_install::*;

const USAGE: &str = "\
usage: icloudkeys-install <status|install|uninstall> [options]

  status      show, per browser, whether Apple's Passwords host is registered
  install     copy Apple's host manifest into each installed Chromium browser
  uninstall   remove only the copies this tool wrote

options:
  --dry-run            print what would change, write nothing
  --all                also target browsers whose data dir exists but whose app is gone
  --support-root DIR   default: ~/Library/Application Support
  --source FILE        default: /Library/Google/Chrome/NativeMessagingHosts/com.apple.passwordmanager.json";

fn main() -> ExitCode {
    match run(std::env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: Vec<String>) -> Result<(), String> {
    let mut cmd = None;
    let mut dry_run = false;
    let mut all = false;
    let mut support_root = None;
    let mut source = PathBuf::from(DEFAULT_SOURCE);
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dry-run" => dry_run = true,
            "--all" => all = true,
            "--support-root" => {
                support_root = Some(PathBuf::from(
                    it.next().ok_or("--support-root needs a value")?,
                ))
            }
            "--source" => source = PathBuf::from(it.next().ok_or("--source needs a value")?),
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(());
            }
            "status" | "install" | "uninstall" if cmd.is_none() => cmd = Some(a),
            _ => return Err(format!("unexpected argument {a:?}\n\n{USAGE}")),
        }
    }
    let Some(cmd) = cmd else {
        println!("{USAGE}");
        return Ok(());
    };
    let support_root = match support_root {
        Some(p) => p,
        None => home()?.join("Library/Application Support"),
    };
    let mut cfg = Config::new(support_root, source);
    cfg.include_uninstalled = all;

    if cmd == "uninstall" {
        let removals = uninstall(&cfg, dry_run).map_err(|e| e.to_string())?;
        if removals.is_empty() {
            println!("nothing to remove: {NAME} has not installed any manifests");
        }
        let verb = if dry_run { "would remove" } else { "removed" };
        for r in removals {
            match r {
                Removal::Removed(p) => println!("{verb}  {}", p.display()),
                Removal::AlreadyGone(p) => println!("gone     {}", p.display()),
                Removal::Kept(p) => {
                    println!("kept     {} (no longer Apple's manifest)", p.display())
                }
            }
        }
        return Ok(());
    }

    let src = load_source(&cfg.source)?;
    let targets = survey(&cfg, &src, &app_installed).map_err(|e| e.to_string())?;
    print_targets(&targets);
    if cmd == "status" {
        return Ok(());
    }

    let written = install(&cfg, &src, &targets, dry_run).map_err(|e| e.to_string())?;
    println!();
    if written.is_empty() {
        println!("nothing to do: every installed browser is already registered");
    } else {
        let verb = if dry_run { "would write" } else { "wrote" };
        for w in &written {
            println!("{verb}  {}", w.path.display());
            if let Some(bak) = &w.backup {
                println!(
                    "      (the differing copy there was not written by {NAME}; kept as {})",
                    bak.display()
                );
            }
        }
        if !dry_run {
            println!(
                "\nIf an already-open browser still can't reach Passwords, quit it fully (Cmd+Q) and reopen it."
            );
        }
    }
    Ok(())
}

fn print_targets(targets: &[Target]) {
    for t in targets {
        let state = match t.state {
            State::SystemCovered => "ok (reads Apple's system manifest)",
            State::NotInstalled => continue,
            State::Identical if t.owned => &format!("ok (installed by {NAME})"),
            State::Identical => "ok (already present)",
            State::Absent => "missing",
            State::Differs => "stale (differs from Apple's manifest)",
        };
        let helper = match t.browser.helper {
            Helper::Verified => "",
            Helper::Expected => "  [helper acceptance expected, untested]",
            Helper::Unverified => "  [helper may refuse this browser's signature]",
        };
        println!("{:<22} {state}{helper}", t.browser.name);
    }
}

/// Spotlight finds apps outside /Applications; the direct checks cover Spotlight being off.
fn app_installed(b: &Browser) -> bool {
    let query = format!("kMDItemCFBundleIdentifier == '{}'", b.bundle_id);
    let found = Command::new("mdfind")
        .arg(query)
        .output()
        .is_ok_and(|o| o.status.success() && o.stdout.iter().any(|c| !c.is_ascii_whitespace()));
    found
        || Path::new("/Applications").join(b.app).is_dir()
        || home().is_ok_and(|h| h.join("Applications").join(b.app).is_dir())
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".into())
}
