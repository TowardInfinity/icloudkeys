//! Copies Apple's `com.apple.passwordmanager` native-messaging host manifest into the
//! per-user `NativeMessagingHosts` dir of every installed Chromium browser that does not
//! already read Chrome's system-level copy.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

pub const NAME: &str = "iCloudKeys";
pub const HOST_NAME: &str = "com.apple.passwordmanager";
pub const HOST_FILE: &str = "com.apple.passwordmanager.json";
/// Apple's Chrome Web Store extension ID; the iCloudKeys build ships Apple's key to get it.
pub const APPLE_CHROME_ORIGIN: &str = "chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/";
pub const DEFAULT_SOURCE: &str =
    "/Library/Google/Chrome/NativeMessagingHosts/com.apple.passwordmanager.json";

/// Whether Apple's helper is known to accept this browser's code signature (macOS 15.4+).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Helper {
    /// Tested on a real machine.
    Verified,
    /// Reported to be on Apple's whitelist, not tested here.
    Expected,
    /// Not known; the manifest can be installed but the helper may refuse the browser.
    Unverified,
}

#[derive(Debug)]
pub struct Browser {
    pub name: &'static str,
    pub bundle_id: &'static str,
    pub app: &'static str,
    /// User data dir under `~/Library/Application Support`. `None` means the browser already
    /// reads the system manifest Apple installs, so a user copy would only shadow it.
    pub data_dir: Option<&'static str>,
    pub helper: Helper,
}

#[rustfmt::skip]
pub const BROWSERS: &[Browser] = &[
    Browser { name: "Google Chrome", bundle_id: "com.google.Chrome", app: "Google Chrome.app", data_dir: None, helper: Helper::Verified },
    Browser { name: "Google Chrome Beta", bundle_id: "com.google.Chrome.beta", app: "Google Chrome Beta.app", data_dir: None, helper: Helper::Expected },
    Browser { name: "Google Chrome Dev", bundle_id: "com.google.Chrome.dev", app: "Google Chrome Dev.app", data_dir: None, helper: Helper::Expected },
    Browser { name: "Google Chrome Canary", bundle_id: "com.google.Chrome.canary", app: "Google Chrome Canary.app", data_dir: None, helper: Helper::Expected },
    Browser { name: "Brave", bundle_id: "com.brave.Browser", app: "Brave Browser.app", data_dir: Some("BraveSoftware/Brave-Browser"), helper: Helper::Verified },
    Browser { name: "Brave Beta", bundle_id: "com.brave.Browser.beta", app: "Brave Browser Beta.app", data_dir: Some("BraveSoftware/Brave-Browser-Beta"), helper: Helper::Unverified },
    Browser { name: "Brave Nightly", bundle_id: "com.brave.Browser.nightly", app: "Brave Browser Nightly.app", data_dir: Some("BraveSoftware/Brave-Browser-Nightly"), helper: Helper::Unverified },
    Browser { name: "Microsoft Edge", bundle_id: "com.microsoft.edgemac", app: "Microsoft Edge.app", data_dir: Some("Microsoft Edge"), helper: Helper::Expected },
    Browser { name: "Arc", bundle_id: "company.thebrowser.Browser", app: "Arc.app", data_dir: Some("Arc/User Data"), helper: Helper::Expected },
    Browser { name: "Vivaldi", bundle_id: "com.vivaldi.Vivaldi", app: "Vivaldi.app", data_dir: Some("Vivaldi"), helper: Helper::Unverified },
    Browser { name: "Chromium", bundle_id: "org.chromium.Chromium", app: "Chromium.app", data_dir: Some("Chromium"), helper: Helper::Unverified },
];

pub struct Config {
    pub support_root: PathBuf,
    pub source: PathBuf,
    pub receipt: PathBuf,
    /// Also target browsers whose data dir exists but whose app was not found.
    pub include_uninstalled: bool,
}

impl Config {
    pub fn new(support_root: PathBuf, source: PathBuf) -> Self {
        let receipt = support_root.join(NAME).join("receipt.json");
        Config {
            support_root,
            source,
            receipt,
            include_uninstalled: false,
        }
    }
}

#[derive(Debug)]
pub struct Source {
    pub bytes: Vec<u8>,
    pub json: Value,
    pub helper_path: PathBuf,
}

/// Reads Apple's manifest and checks it still describes a usable host. It is copied
/// byte-for-byte, so nothing here (helper path, origins) is hardcoded into the copies.
pub fn load_source(path: &Path) -> Result<Source, String> {
    let bytes = fs::read(path).map_err(|e| {
        format!("can't read Apple's host manifest at {}: {e}. Is macOS Passwords' browser support installed?", path.display())
    })?;
    let v: Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?;
    if v["name"] != HOST_NAME {
        return Err(format!(
            "{} names host {}, expected {HOST_NAME}",
            path.display(),
            v["name"]
        ));
    }
    let helper_path = v["path"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| format!("{} has no helper path", path.display()))?;
    if !helper_path.exists() {
        return Err(format!(
            "helper binary {} is missing; Apple may have moved it",
            helper_path.display()
        ));
    }
    let origins = v["allowed_origins"].as_array().cloned().unwrap_or_default();
    if !origins.iter().any(|o| o == APPLE_CHROME_ORIGIN) {
        return Err(format!(
            "{} no longer allows {APPLE_CHROME_ORIGIN}",
            path.display()
        ));
    }
    Ok(Source {
        bytes,
        json: v,
        helper_path,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Reads Apple's system manifest already.
    SystemCovered,
    /// App not found (and its data dir is skipped unless `include_uninstalled`).
    NotInstalled,
    Identical,
    Absent,
    /// A manifest is there but its bytes differ from Apple's, e.g. stale after a macOS update.
    Differs,
}

#[derive(Debug)]
pub struct Target {
    pub browser: &'static Browser,
    pub manifest: Option<PathBuf>,
    pub state: State,
    /// Listed in our receipt, i.e. this tool wrote it.
    pub owned: bool,
}

pub fn survey(
    cfg: &Config,
    source: &Source,
    is_installed: &dyn Fn(&Browser) -> bool,
) -> io::Result<Vec<Target>> {
    let owned = read_receipt(&cfg.receipt)?;
    Ok(BROWSERS
        .iter()
        .map(|b| {
            let Some(dir) = b.data_dir else {
                let state = if is_installed(b) {
                    State::SystemCovered
                } else {
                    State::NotInstalled
                };
                return Target {
                    browser: b,
                    manifest: None,
                    state,
                    owned: false,
                };
            };
            let data = cfg.support_root.join(dir);
            let manifest = data.join("NativeMessagingHosts").join(HOST_FILE);
            let wanted = is_installed(b) || (cfg.include_uninstalled && data.is_dir());
            let state = if !wanted {
                State::NotInstalled
            } else {
                match fs::read(&manifest) {
                    // whitespace-only differences don't make a copy stale
                    Ok(bytes)
                        if serde_json::from_slice::<Value>(&bytes)
                            .is_ok_and(|v| v == source.json) =>
                    {
                        State::Identical
                    }
                    Ok(_) => State::Differs,
                    Err(_) => State::Absent,
                }
            };
            let owned = owned.contains(&manifest);
            Target {
                browser: b,
                manifest: Some(manifest),
                state,
                owned,
            }
        })
        .collect())
}

#[derive(Debug, PartialEq, Eq)]
pub struct Written {
    pub path: PathBuf,
    /// Where a differing manifest we did not write was moved before being replaced.
    pub backup: Option<PathBuf>,
}

/// Writes Apple's manifest wherever it is absent or differs. Only files this tool created
/// go in the receipt, so `uninstall` never removes a copy someone else put there; a foreign
/// copy that differs is re-synced, with the old one kept as `<file>.bak`.
pub fn install(
    cfg: &Config,
    source: &Source,
    targets: &[Target],
    dry_run: bool,
) -> io::Result<Vec<Written>> {
    let mut written = Vec::new();
    let mut created = Vec::new();
    for t in targets {
        if !matches!(t.state, State::Absent | State::Differs) {
            continue;
        }
        let path = t
            .manifest
            .as_ref()
            .expect("user-dir targets have a manifest path");
        let foreign = t.state == State::Differs && !t.owned;
        let backup = foreign.then(|| path.with_extension("json.bak"));
        if !dry_run {
            fs::create_dir_all(path.parent().unwrap())?;
            if let Some(bak) = &backup {
                fs::rename(path, bak)?;
            }
            fs::write(path, &source.bytes)?;
        }
        if !foreign {
            created.push(path.clone());
        }
        written.push(Written {
            path: path.clone(),
            backup,
        });
    }
    if !dry_run && !created.is_empty() {
        let mut owned = read_receipt(&cfg.receipt)?;
        owned.extend(created);
        write_receipt(&cfg.receipt, &owned)?;
    }
    Ok(written)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Removal {
    Removed(PathBuf),
    AlreadyGone(PathBuf),
    /// Receipted, but the file no longer holds Apple's host manifest, so it is left alone.
    Kept(PathBuf),
}

pub fn uninstall(cfg: &Config, dry_run: bool) -> io::Result<Vec<Removal>> {
    let mut out = Vec::new();
    for path in read_receipt(&cfg.receipt)? {
        let Ok(bytes) = fs::read(&path) else {
            out.push(Removal::AlreadyGone(path));
            continue;
        };
        let is_host = serde_json::from_slice::<Value>(&bytes).is_ok_and(|v| v["name"] == HOST_NAME);
        if !is_host {
            out.push(Removal::Kept(path));
            continue;
        }
        if !dry_run {
            fs::remove_file(&path)?;
        }
        out.push(Removal::Removed(path));
    }
    if !dry_run {
        match fs::remove_file(&cfg.receipt) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        if let Some(dir) = cfg.receipt.parent() {
            let _ = fs::remove_dir(dir); // only succeeds if empty
        }
    }
    Ok(out)
}

fn read_receipt(path: &Path) -> io::Result<BTreeSet<PathBuf>> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(BTreeSet::new()),
        Err(e) => return Err(e),
    };
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{}: {e}", path.display()),
        )
    })?;
    Ok(v["installed"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p.as_str().map(PathBuf::from))
        .collect())
}

fn write_receipt(path: &Path, owned: &BTreeSet<PathBuf>) -> io::Result<()> {
    fs::create_dir_all(path.parent().unwrap())?;
    let paths: Vec<_> = owned.iter().map(|p| p.to_string_lossy()).collect();
    let body = serde_json::to_vec_pretty(&json!({ "installed": paths }))?;
    fs::write(path, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let p = std::env::temp_dir().join(format!(
                "icloudkeys-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture(tmp: &Tmp) -> (Config, Source) {
        let helper = tmp.0.join("Helper");
        fs::write(&helper, "").unwrap();
        let src = tmp.0.join("source.json");
        let manifest = json!({
            "name": HOST_NAME,
            "path": helper,
            "type": "stdio",
            "allowed_origins": [APPLE_CHROME_ORIGIN],
        });
        fs::write(&src, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
        let support = tmp.0.join("Application Support");
        fs::create_dir_all(&support).unwrap();
        let source = load_source(&src).unwrap();
        (Config::new(support, src), source)
    }

    fn only(ids: &'static [&'static str]) -> impl Fn(&Browser) -> bool {
        move |b| ids.contains(&b.bundle_id)
    }

    fn state_of(targets: &[Target], id: &str) -> State {
        targets
            .iter()
            .find(|t| t.browser.bundle_id == id)
            .unwrap()
            .state
    }

    fn manifest_of(cfg: &Config, dir: &str) -> PathBuf {
        cfg.support_root
            .join(dir)
            .join("NativeMessagingHosts")
            .join(HOST_FILE)
    }

    #[test]
    fn source_must_keep_apples_extension_origin() {
        let tmp = Tmp::new();
        let (cfg, _) = fixture(&tmp);
        let mut v: Value = serde_json::from_slice(&fs::read(&cfg.source).unwrap()).unwrap();
        v["allowed_origins"] = json!(["chrome-extension://someoneelse/"]);
        fs::write(&cfg.source, v.to_string()).unwrap();
        assert!(
            load_source(&cfg.source)
                .unwrap_err()
                .contains("no longer allows")
        );
    }

    #[test]
    fn source_helper_binary_must_exist() {
        let tmp = Tmp::new();
        let (cfg, source) = fixture(&tmp);
        fs::remove_file(&source.helper_path).unwrap();
        assert!(load_source(&cfg.source).unwrap_err().contains("is missing"));
    }

    #[test]
    fn chrome_is_covered_by_the_system_manifest_and_never_written() {
        let tmp = Tmp::new();
        let (cfg, source) = fixture(&tmp);
        let targets = survey(&cfg, &source, &only(&["com.google.Chrome"])).unwrap();
        assert_eq!(
            state_of(&targets, "com.google.Chrome"),
            State::SystemCovered
        );
        assert!(install(&cfg, &source, &targets, false).unwrap().is_empty());
    }

    #[test]
    fn leftover_data_dir_without_the_app_is_skipped_unless_asked() {
        let tmp = Tmp::new();
        let (mut cfg, source) = fixture(&tmp);
        fs::create_dir_all(cfg.support_root.join("Vivaldi")).unwrap();
        let none = only(&[]);
        assert_eq!(
            state_of(
                &survey(&cfg, &source, &none).unwrap(),
                "com.vivaldi.Vivaldi"
            ),
            State::NotInstalled
        );
        cfg.include_uninstalled = true;
        let targets = survey(&cfg, &source, &none).unwrap();
        assert_eq!(state_of(&targets, "com.vivaldi.Vivaldi"), State::Absent);
        // a data dir that does not exist is still skipped
        assert_eq!(
            state_of(&targets, "company.thebrowser.Browser"),
            State::NotInstalled
        );
    }

    #[test]
    fn install_copies_bytes_creates_dirs_and_is_idempotent() {
        let tmp = Tmp::new();
        let (cfg, source) = fixture(&tmp);
        let installed = only(&["com.brave.Browser"]);
        let targets = survey(&cfg, &source, &installed).unwrap();
        assert_eq!(state_of(&targets, "com.brave.Browser"), State::Absent);
        let written = install(&cfg, &source, &targets, false).unwrap();
        let brave = manifest_of(&cfg, "BraveSoftware/Brave-Browser");
        assert_eq!(
            written,
            vec![Written {
                path: brave.clone(),
                backup: None
            }]
        );
        assert_eq!(fs::read(&brave).unwrap(), source.bytes);

        let again = survey(&cfg, &source, &installed).unwrap();
        let t = again
            .iter()
            .find(|t| t.browser.bundle_id == "com.brave.Browser")
            .unwrap();
        assert_eq!((t.state, t.owned), (State::Identical, true));
        assert!(install(&cfg, &source, &again, false).unwrap().is_empty());
    }

    #[test]
    fn stale_copy_is_resynced() {
        let tmp = Tmp::new();
        let (cfg, source) = fixture(&tmp);
        let edge = manifest_of(&cfg, "Microsoft Edge");
        fs::create_dir_all(edge.parent().unwrap()).unwrap();
        fs::write(
            &edge,
            r#"{"name":"com.apple.passwordmanager","path":"/old/path"}"#,
        )
        .unwrap();
        let targets = survey(&cfg, &source, &only(&["com.microsoft.edgemac"])).unwrap();
        assert_eq!(state_of(&targets, "com.microsoft.edgemac"), State::Differs);
        let bak = edge.with_extension("json.bak");
        assert_eq!(
            install(&cfg, &source, &targets, false).unwrap(),
            vec![Written {
                path: edge.clone(),
                backup: Some(bak.clone())
            }]
        );
        assert_eq!(fs::read(&edge).unwrap(), source.bytes);
        assert!(fs::read_to_string(&bak).unwrap().contains("/old/path"));

        // we did not create it, so it is not ours to remove
        assert!(uninstall(&cfg, false).unwrap().is_empty());
        assert!(edge.exists() && bak.exists());
    }

    #[test]
    fn dry_run_writes_nothing() {
        let tmp = Tmp::new();
        let (cfg, source) = fixture(&tmp);
        let targets = survey(&cfg, &source, &only(&["company.thebrowser.Browser"])).unwrap();
        let written = install(&cfg, &source, &targets, true).unwrap();
        assert_eq!(written.len(), 1);
        assert!(!written[0].path.exists());
        assert!(!cfg.receipt.exists());
    }

    #[test]
    fn reformatted_copy_counts_as_identical() {
        let tmp = Tmp::new();
        let (cfg, source) = fixture(&tmp);
        let arc = manifest_of(&cfg, "Arc/User Data");
        fs::create_dir_all(arc.parent().unwrap()).unwrap();
        fs::write(&arc, source.json.to_string()).unwrap();
        let targets = survey(&cfg, &source, &only(&["company.thebrowser.Browser"])).unwrap();
        assert_eq!(
            state_of(&targets, "company.thebrowser.Browser"),
            State::Identical
        );
    }

    #[test]
    fn uninstall_removes_only_receipted_copies() {
        let tmp = Tmp::new();
        let (cfg, source) = fixture(&tmp);
        // a copy someone else placed before we ran
        let chromium = manifest_of(&cfg, "Chromium");
        fs::create_dir_all(chromium.parent().unwrap()).unwrap();
        fs::write(&chromium, &source.bytes).unwrap();

        let installed = only(&["com.brave.Browser", "org.chromium.Chromium"]);
        let targets = survey(&cfg, &source, &installed).unwrap();
        let chromium_target = targets
            .iter()
            .find(|t| t.browser.bundle_id == "org.chromium.Chromium")
            .unwrap();
        assert_eq!(
            (chromium_target.state, chromium_target.owned),
            (State::Identical, false)
        );
        install(&cfg, &source, &targets, false).unwrap();

        let brave = manifest_of(&cfg, "BraveSoftware/Brave-Browser");
        assert_eq!(
            uninstall(&cfg, false).unwrap(),
            vec![Removal::Removed(brave.clone())]
        );
        assert!(!brave.exists());
        assert!(chromium.exists());
        assert!(!cfg.receipt.exists());
    }

    #[test]
    fn uninstall_keeps_a_receipted_file_that_is_no_longer_apples_manifest() {
        let tmp = Tmp::new();
        let (cfg, source) = fixture(&tmp);
        let targets = survey(&cfg, &source, &only(&["com.vivaldi.Vivaldi"])).unwrap();
        install(&cfg, &source, &targets, false).unwrap();
        let vivaldi = manifest_of(&cfg, "Vivaldi");
        fs::write(&vivaldi, r#"{"name":"something.else"}"#).unwrap();
        assert_eq!(
            uninstall(&cfg, false).unwrap(),
            vec![Removal::Kept(vivaldi.clone())]
        );
        assert!(vivaldi.exists());
    }
}
