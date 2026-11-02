//! Feeds, downloads and artifact verification.

use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::StatusCode;
use sha2::{Digest, Sha256};
use url::Url;

use crate::error::{codes, LauncherError};
use crate::feed::{parse_artifact_url, Arch, Feed, Kind, Os};
use crate::progress::{Phase, ProgressEvent};

/// Feed document cap: the real file is a few kilobytes; anything larger is a
/// misconfigured server rather than a version list.
const MAX_FEED_BYTES: u64 = 2 * 1024 * 1024;
const READ_BUFFER: usize = 64 * 1024;

fn user_agent() -> String {
    format!("Gentree-Launcher/{}", env!("CARGO_PKG_VERSION"))
}

fn client(loopback: bool) -> Result<Client, LauncherError> {
    let mut builder = Client::builder()
        .user_agent(user_agent())
        .connect_timeout(Duration::from_secs(20))
        .redirect(redirect_policy());
    if loopback {
        // A local fixture server must not be routed through a system proxy.
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|_| LauncherError::new(codes::NETWORK))
}

/// Follows redirects only while they stay on an allowed transport; a redirect
/// from HTTPS to plain HTTP outside loopback is refused instead of silently
/// downgrading the download.
fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if parse_artifact_url(attempt.url().as_str()).is_ok() {
            attempt.follow()
        } else {
            attempt.error("insecure redirect")
        }
    })
}

fn network_error(error: reqwest::Error) -> LauncherError {
    let detail = if error.is_timeout() {
        "timeout"
    } else {
        "request"
    };
    LauncherError::with_detail(codes::NETWORK, detail)
}

fn status_error(status: StatusCode) -> LauncherError {
    LauncherError::with_detail(codes::HTTP_STATUS, status.as_u16().to_string())
}

/// Downloads and validates the version feed.
pub fn fetch_feed(raw_url: &str) -> Result<Feed, LauncherError> {
    let url = parse_artifact_url(raw_url)?;
    let response = client(crate::feed::is_loopback_host(&url)).and_then(|client| {
        client
            .get(url.clone())
            .timeout(Duration::from_secs(20))
            .send()
            .map_err(network_error)
    })?;

    if !response.status().is_success() {
        return Err(status_error(response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_FEED_BYTES)
    {
        return Err(LauncherError::new(codes::FEED_TOO_LARGE));
    }

    let mut body = String::new();
    response
        .take(MAX_FEED_BYTES + 1)
        .read_to_string(&mut body)
        .map_err(|_| LauncherError::new(codes::NETWORK))?;
    if body.len() as u64 > MAX_FEED_BYTES {
        return Err(LauncherError::new(codes::FEED_TOO_LARGE));
    }
    Feed::parse(&body)
}

/// Last URL path segment when it is safe as a file name, else `None`.
pub fn safe_file_name(url: &Url) -> Option<String> {
    let name = url.path_segments()?.next_back()?.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.starts_with('.')
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return None;
    }
    Some(name.to_string())
}

/// Default artifact name when the URL has no usable last segment.
pub fn fallback_file_name(version: &str, os: Os, arch: Arch, kind: Kind) -> String {
    let extension = match kind {
        Kind::Nsis => "exe",
        Kind::Dmg => "dmg",
    };
    format!(
        "Gentree_{version}_{}_{}.{extension}",
        os.as_str(),
        arch.as_str()
    )
}

/// Hashes a file and returns the lowercase hex digest.
pub fn verify_file(path: &Path, expected: &str) -> Result<(), LauncherError> {
    let mut file = File::open(path).map_err(|_| LauncherError::new(codes::DOWNLOAD_READ))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; READ_BUFFER];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| LauncherError::new(codes::DOWNLOAD_READ))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = hex::encode(hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected.trim()) {
        return Err(LauncherError::new(codes::CHECKSUM_MISMATCH));
    }
    Ok(())
}

/// Streams an artifact into `directory`, verifying its SHA-256 while writing.
///
/// A mismatch or I/O failure removes the partial file, and the caller only
/// ever receives a path whose bytes were hashed against the feed.
pub fn download(
    raw_url: &str,
    expected_sha256: &str,
    expected_size: Option<u64>,
    directory: &Path,
    file_name: &str,
    progress: &mut dyn FnMut(ProgressEvent),
) -> Result<PathBuf, LauncherError> {
    let url = parse_artifact_url(raw_url)?;
    fs::create_dir_all(directory).map_err(|_| LauncherError::new(codes::DOWNLOAD_WRITE))?;

    let final_path = directory.join(file_name);
    let part_path = directory.join(format!("{file_name}.part"));
    let result = download_to(&url, expected_sha256, expected_size, &part_path, progress);
    match result {
        Ok(()) => {
            if fs::rename(&part_path, &final_path).is_err() {
                let _ = fs::remove_file(&part_path);
                return Err(LauncherError::new(codes::DOWNLOAD_WRITE));
            }
            Ok(final_path)
        }
        Err(error) => {
            let _ = fs::remove_file(&part_path);
            Err(error)
        }
    }
}

fn download_to(
    url: &Url,
    expected_sha256: &str,
    expected_size: Option<u64>,
    part_path: &Path,
    progress: &mut dyn FnMut(ProgressEvent),
) -> Result<(), LauncherError> {
    let mut response = client(crate::feed::is_loopback_host(url))
        .and_then(|client| client.get(url.clone()).send().map_err(network_error))?;
    if !response.status().is_success() {
        return Err(status_error(response.status()));
    }

    let total = response.content_length().or(expected_size);
    let mut file = BufWriter::new(
        File::create(part_path).map_err(|_| LauncherError::new(codes::DOWNLOAD_WRITE))?,
    );
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut buffer = [0u8; READ_BUFFER];

    progress(ProgressEvent::new(Phase::Download, 0, total));
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|_| LauncherError::new(codes::DOWNLOAD_READ))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|_| LauncherError::new(codes::DOWNLOAD_WRITE))?;
        hasher.update(&buffer[..read]);
        received += read as u64;
        progress(ProgressEvent::new(Phase::Download, received, total));
    }
    file.flush()
        .map_err(|_| LauncherError::new(codes::DOWNLOAD_WRITE))?;

    progress(ProgressEvent::new(Phase::Verify, received, total));
    let actual = hex::encode(hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected_sha256.trim()) {
        return Err(LauncherError::new(codes::CHECKSUM_MISMATCH));
    }
    if let Some(expected) = expected_size {
        if expected != received {
            return Err(LauncherError::with_detail(
                codes::SIZE_MISMATCH,
                format!("expected {expected}, got {received}"),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;

    const CONTENT: &[u8] = b"synthetic installer bytes";

    fn digest_of(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("url")
    }

    /// Serves one HTTP response on a loopback port and returns its URL.
    fn serve_once(body: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("local addr").port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).expect("header");
            stream.write_all(&body).expect("body");
            stream.flush().expect("flush");
        });
        (format!("http://127.0.0.1:{port}/artifact"), handle)
    }

    #[test]
    fn verifies_a_matching_checksum() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("artifact.exe");
        fs::write(&path, CONTENT).expect("write");

        verify_file(&path, &digest_of(CONTENT)).expect("matching digest");
        verify_file(&path, &digest_of(CONTENT).to_ascii_uppercase()).expect("case-insensitive");
    }

    #[test]
    fn rejects_a_mismatched_checksum() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("artifact.exe");
        fs::write(&path, CONTENT).expect("write");

        let error = verify_file(&path, &"0".repeat(64)).expect_err("mismatch");

        assert_eq!(error.code, codes::CHECKSUM_MISMATCH);
    }

    #[test]
    fn rejects_a_missing_file() {
        let dir = tempfile::tempdir().expect("temp");
        let error =
            verify_file(&dir.path().join("missing.exe"), &"0".repeat(64)).expect_err("missing");

        assert_eq!(error.code, codes::DOWNLOAD_READ);
    }

    #[test]
    fn accepts_safe_artifact_names_only() {
        assert_eq!(
            safe_file_name(&url(
                "https://downloads.example/Gentree_0.2.1_x64-setup.exe"
            )),
            Some("Gentree_0.2.1_x64-setup.exe".to_string())
        );
        assert_eq!(
            safe_file_name(&url("https://downloads.example/path/")),
            None
        );
        assert_eq!(
            safe_file_name(&url("https://downloads.example/%2e%2e%2fevil")),
            None
        );
        assert_eq!(
            safe_file_name(&url("https://downloads.example/a?download=1")),
            Some("a".to_string())
        );
        assert_eq!(
            safe_file_name(&url("https://downloads.example/.hidden")),
            None
        );
    }

    #[test]
    fn builds_a_fallback_name_for_opaque_urls() {
        let name = fallback_file_name("0.2.1", Os::Macos, Arch::Aarch64, Kind::Dmg);

        assert_eq!(name, "Gentree_0.2.1_macos_aarch64.dmg");
    }

    #[test]
    fn downloads_and_verifies_over_loopback() {
        let (endpoint, server) = serve_once(CONTENT.to_vec());
        let dir = tempfile::tempdir().expect("temp");
        let mut ticks = 0usize;

        let path = download(
            &endpoint,
            &digest_of(CONTENT),
            Some(CONTENT.len() as u64),
            dir.path(),
            "artifact.exe",
            &mut |_| ticks += 1,
        )
        .expect("download");

        server.join().expect("server");
        assert_eq!(fs::read(&path).expect("read"), CONTENT);
        assert!(!dir.path().join("artifact.exe.part").exists());
        assert!(ticks >= 2, "expected download and verify ticks");
    }

    #[test]
    fn removes_the_partial_file_on_a_checksum_mismatch() {
        let (endpoint, server) = serve_once(CONTENT.to_vec());
        let dir = tempfile::tempdir().expect("temp");

        let error = download(
            &endpoint,
            &"0".repeat(64),
            None,
            dir.path(),
            "artifact.exe",
            &mut |_| {},
        )
        .expect_err("checksum mismatch");

        server.join().expect("server");
        assert_eq!(error.code, codes::CHECKSUM_MISMATCH);
        assert!(!dir.path().join("artifact.exe").exists());
        assert!(!dir.path().join("artifact.exe.part").exists());
    }

    #[test]
    fn refuses_a_plain_http_feed_outside_loopback() {
        let error = fetch_feed("http://downloads.example/versions.json").expect_err("remote http");

        assert_eq!(error.code, codes::FEED_URL);
    }

    #[test]
    fn fetches_a_loopback_feed() {
        let body = format!(
            r#"{{"schema":1,"app":"gentree","latest":"0.2.1","versions":[{{"version":"0.2.1","released":"2026-11-01T12:00:00Z","notes":"synthetic","prerelease":false,"files":[{{"os":"windows","arch":"x86_64","kind":"nsis","url":"https://downloads.example/a.exe","sha256":"{}"}}]}}]}}"#,
            digest_of(CONTENT)
        );
        let (endpoint, server) = serve_once(body.into_bytes());

        let feed = fetch_feed(&endpoint).expect("feed");

        server.join().expect("server");
        assert_eq!(feed.latest.as_deref(), Some("0.2.1"));
    }
}
