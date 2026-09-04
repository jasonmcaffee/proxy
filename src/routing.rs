use crate::config::Config;
use hyper::{HeaderMap, header::HOST};
use serde::Serialize;
use url::Url;

const DEFAULT_HOST: &str = "jasonmcaffee.com";
const MEDIA_HOST: &str = "media.jasonmcaffee.com";

/// Stable low-cardinality route names used by logs and metrics.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RouteClass {
    AiApi,
    AiSocket,
    News,
    AiUi,
    PersonalSite,
    MediaUi,
    MediaAsset,
    SocialStage,
    Plex,
    Git,
    Phone,
    ChordicalApi,
    ChordicalUi,
    Nikaya,
    BlackRainbowUi,
    UnluminousUi,
}

impl RouteClass {
    /// Returns the stable metric label for this route class.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AiApi => "ai-api",
            Self::AiSocket => "ai-socket",
            Self::News => "news",
            Self::AiUi => "ai-ui",
            Self::PersonalSite => "personal-site",
            Self::MediaUi => "media-ui",
            Self::MediaAsset => "media-asset",
            Self::SocialStage => "social-stage",
            Self::Plex => "plex",
            Self::Git => "git",
            Self::Phone => "phone",
            Self::ChordicalApi => "chordical-api",
            Self::ChordicalUi => "chordical-ui",
            Self::Nikaya => "nikaya",
            Self::BlackRainbowUi => "black-rainbow-ui",
            Self::UnluminousUi => "unluminous-ui",
        }
    }

    /// Returns the public-safe message used when this route's upstream fails.
    pub fn failure_message(self) -> &'static str {
        match self {
            Self::MediaAsset => "Unable to reach the media library",
            Self::SocialStage => "Unable to reach the media staging service",
            Self::AiApi | Self::AiSocket | Self::News => "Unable to reach AI service backend",
            Self::Nikaya => "Unable to reach the Nikaya service",
            Self::BlackRainbowUi => "Unable to reach the Black Rainbow Labs site",
            Self::UnluminousUi => "Unable to reach the Unluminous site",
            _ => "Unable to proxy request to backend service",
        }
    }
}

/// Complete routing decision for one inbound request.
#[derive(Clone, Debug)]
pub struct RouteDecision {
    pub class: RouteClass,
    pub target: Url,
    pub upstream_path: String,
    pub original_host: String,
    pub plex_headers: bool,
    pub forwarded_host_override: Option<&'static str>,
}

/// Selects an upstream and path rewrite using the ordered production contract.
pub fn route_request(config: &Config, headers: &HeaderMap, path_and_query: &str) -> RouteDecision {
    let original_host = header_host(headers);
    let host = normalize_host(&original_host);
    let path = path_only(path_and_query);

    if segment_prefix(path, "/ai-api") {
        return decision(RouteClass::AiApi, &config.ai_service_target, rewrite_prefix(path_and_query, "/ai-api", "/"), original_host);
    }
    if host == "ai.jasonmcaffee.com" && segment_prefix(path, "/socket.io") {
        return decision(RouteClass::AiSocket, &config.ai_service_target, path_and_query.to_string(), original_host);
    }
    if host == MEDIA_HOST && segment_prefix(path, "/m") {
        return decision(RouteClass::MediaAsset, &config.phone_sync_target, rewrite_prefix(path_and_query, "/m", "/public"), original_host);
    }
    if host == MEDIA_HOST && segment_prefix(path, "/s") {
        let mut result =
            decision(RouteClass::SocialStage, &config.ai_service_target, rewrite_prefix(path_and_query, "/s", "/social/public-media"), original_host);
        result.forwarded_host_override = Some(MEDIA_HOST);
        return result;
    }
    if segment_prefix(path, "/news") {
        return decision(RouteClass::News, &config.ai_service_target, path_and_query.to_string(), original_host);
    }

    let (class, target) = match host.as_str() {
        "ai.jasonmcaffee.com" => (RouteClass::AiUi, &config.ai_target),
        MEDIA_HOST => (RouteClass::MediaUi, &config.media_target),
        "plex.jasonmcaffee.com" => (RouteClass::Plex, &config.plex_target),
        "git.jasonmcaffee.com" => (RouteClass::Git, &config.git_target),
        "phone.jasonmcaffee.com" => (RouteClass::Phone, &config.phone_sync_target),
        "taxes.jasonmcaffee.com" => (RouteClass::Nikaya, &config.nikaya_target),
        "api.chordical.com" => (RouteClass::ChordicalApi, &config.chordical_api_target),
        "chordical.com" | "www.chordical.com" => (RouteClass::ChordicalUi, &config.chordical_ui_target),
        "blackrainbowlabs.com" | "www.blackrainbowlabs.com" => (RouteClass::BlackRainbowUi, &config.black_rainbow_target),
        "unluminous.com" | "www.unluminous.com" => (RouteClass::UnluminousUi, &config.unluminous_target),
        // Everything unrouted still lands on the personal site. That default used to point at
        // llama-server, which answered the public internet with the local model list, so a new arm
        // above it is always added with a test that proves this line has not moved.
        _ => (RouteClass::PersonalSite, &config.nextjs_target),
    };
    let mut result = decision(class, target, path_and_query.to_string(), original_host);
    result.plex_headers = class == RouteClass::Plex;
    result
}

/// Creates a route decision with the shared defaults applied.
fn decision(class: RouteClass, target: &Url, upstream_path: String, original_host: String) -> RouteDecision {
    RouteDecision { class, target: target.clone(), upstream_path, original_host, plex_headers: false, forwarded_host_override: None }
}

/// Returns the Host header text or the documented personal-site fallback.
fn header_host(headers: &HeaderMap) -> String {
    headers.get(HOST).and_then(|value| value.to_str().ok()).filter(|value| !value.trim().is_empty()).unwrap_or(DEFAULT_HOST).to_string()
}

/// Normalizes an HTTP authority for case-insensitive, port-independent routing.
pub fn normalize_host(host: &str) -> String {
    host.parse::<hyper::http::uri::Authority>()
        .map(|authority| authority.host().trim_end_matches('.').to_ascii_lowercase())
        .unwrap_or_else(|_| host.trim().trim_end_matches('.').to_ascii_lowercase())
}

/// Tests a path prefix on a segment boundary so lookalike paths do not match.
fn segment_prefix(path: &str, prefix: &str) -> bool {
    path == prefix || path.strip_prefix(prefix).is_some_and(|suffix| suffix.starts_with('/'))
}

/// Returns the path portion without a query string.
fn path_only(path_and_query: &str) -> &str {
    path_and_query.split_once('?').map_or(path_and_query, |(path, _)| path)
}

/// Rewrites one leading path segment while preserving the raw query string.
fn rewrite_prefix(path_and_query: &str, prefix: &str, replacement: &str) -> String {
    let (path, query) = path_and_query.split_once('?').map_or((path_and_query, None), |(path, query)| (path, Some(query)));
    let suffix = path.strip_prefix(prefix).unwrap_or(path);
    let rewritten = if suffix.is_empty() {
        replacement.to_string()
    } else if replacement == "/" {
        suffix.to_string()
    } else {
        format!("{replacement}{suffix}")
    };
    match query {
        Some(query) => format!("{rewritten}?{query}"),
        None => rewritten,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    /// Creates the shared test configuration used by pure routing tests.
    fn config() -> Config {
        Config::for_tests(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0), Url::parse("http://127.0.0.1:9999").unwrap())
    }

    /// Creates headers containing one Host authority.
    fn host(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, value.parse().unwrap());
        headers
    }

    #[test]
    fn routes_every_production_hostname() {
        let cases = [
            ("ai.jasonmcaffee.com", RouteClass::AiUi),
            ("media.jasonmcaffee.com", RouteClass::MediaUi),
            ("plex.jasonmcaffee.com", RouteClass::Plex),
            ("git.jasonmcaffee.com", RouteClass::Git),
            ("phone.jasonmcaffee.com", RouteClass::Phone),
            ("taxes.jasonmcaffee.com", RouteClass::Nikaya),
            ("api.chordical.com", RouteClass::ChordicalApi),
            ("chordical.com", RouteClass::ChordicalUi),
            ("www.chordical.com", RouteClass::ChordicalUi),
            ("blackrainbowlabs.com", RouteClass::BlackRainbowUi),
            ("www.blackrainbowlabs.com", RouteClass::BlackRainbowUi),
            ("unluminous.com", RouteClass::UnluminousUi),
            ("www.unluminous.com", RouteClass::UnluminousUi),
            ("jasonmcaffee.com", RouteClass::PersonalSite),
            ("blog.jasonmcaffee.com", RouteClass::PersonalSite),
            ("unrelated.example", RouteClass::PersonalSite),
        ];
        for (hostname, expected) in cases {
            assert_eq!(route_request(&config(), &host(hostname), "/").class, expected, "{hostname}");
        }
    }

    #[test]
    fn normalizes_case_ports_and_trailing_dots() {
        assert_eq!(normalize_host("AI.JasonMcAffee.Com:80"), "ai.jasonmcaffee.com");
        assert_eq!(normalize_host("Chordical.COM."), "chordical.com");
        assert_eq!(normalize_host("WWW.BlackRainbowLabs.COM:80"), "www.blackrainbowlabs.com");
        assert_eq!(normalize_host("BlackRainbowLabs.com."), "blackrainbowlabs.com");
        assert_eq!(normalize_host("WWW.Unluminous.COM:80"), "www.unluminous.com");
    }

    #[test]
    fn keeps_the_personal_site_as_the_catch_all_after_adding_a_host() {
        // The unrouted default answers every hostname nothing else claims, so a new host arm is
        // only safe once this still holds. Asserted separately from the table above so a careless
        // edit to that list cannot quietly take this with it.
        let cfg = config();
        for hostname in ["jasonmcaffee.com", "www.jasonmcaffee.com", "blog.jasonmcaffee.com", "unrelated.example"] {
            assert_eq!(route_request(&cfg, &host(hostname), "/").class, RouteClass::PersonalSite, "{hostname}");
        }
        assert_eq!(route_request(&cfg, &host("blackrainbowlabs.com.evil.example"), "/").class, RouteClass::PersonalSite);
        assert_eq!(route_request(&cfg, &host("unluminous.com.evil.example"), "/").class, RouteClass::PersonalSite);
    }

    #[test]
    fn sends_the_black_rainbow_host_to_its_own_upstream_for_every_path() {
        // The site serves its own video, so a range request on a long asset has to reach it rather
        // than being swept up by one of the shared path rules matched before the host.
        let cfg = config();
        for path in ["/", "/videos/quill.mp4", "/images/hero-droplet.webp", "/no-such-page"] {
            let decision = route_request(&cfg, &host("blackrainbowlabs.com"), path);
            assert_eq!(decision.class, RouteClass::BlackRainbowUi, "{path}");
            assert_eq!(decision.upstream_path, path, "{path}");
        }
    }

    #[test]
    fn sends_the_unluminous_host_to_its_own_upstream_for_every_path() {
        // The site serves its own 33 MB product video, so a range request on it has to reach that
        // upstream rather than being swept up by one of the shared path rules matched before the host.
        let cfg = config();
        for path in ["/", "/videos/unluminous.mp4", "/images/shots/opacity-035.webp", "/no-such-page"] {
            let decision = route_request(&cfg, &host("unluminous.com"), path);
            assert_eq!(decision.class, RouteClass::UnluminousUi, "{path}");
            assert_eq!(decision.upstream_path, path, "{path}");
        }
    }

    #[test]
    fn rewrites_special_paths_and_preserves_queries() {
        let cfg = config();
        assert_eq!(route_request(&cfg, &host("ai.jasonmcaffee.com"), "/ai-api/tasks?q=x").upstream_path, "/tasks?q=x");
        assert_eq!(route_request(&cfg, &host(MEDIA_HOST), "/m/movie.mp4?download=1").upstream_path, "/public/movie.mp4?download=1");
        assert_eq!(route_request(&cfg, &host(MEDIA_HOST), "/s/token.mp4").upstream_path, "/social/public-media/token.mp4");
        assert_eq!(route_request(&cfg, &host("example.com"), "/news/2026-08-21").upstream_path, "/news/2026-08-21");
    }

    #[test]
    fn requires_path_segment_boundaries() {
        let cfg = config();
        assert_eq!(route_request(&cfg, &host("ai.jasonmcaffee.com"), "/ai-api-evil").class, RouteClass::AiUi);
        assert_eq!(route_request(&cfg, &host(MEDIA_HOST), "/mismatch").class, RouteClass::MediaUi);
        assert_eq!(route_request(&cfg, &host("example.com"), "/newsletter").class, RouteClass::PersonalSite);
    }

    #[test]
    fn keeps_the_nikaya_host_off_the_shared_special_paths() {
        // /news and /ai-api are matched before the host, so a Nikaya path that happens to start with
        // one of those segments would otherwise be handed to the AI backend instead.
        let cfg = config();
        assert_eq!(route_request(&cfg, &host("taxes.jasonmcaffee.com"), "/api/auth/login").class, RouteClass::Nikaya);
        assert_eq!(route_request(&cfg, &host("taxes.jasonmcaffee.com"), "/newsletter").class, RouteClass::Nikaya);
        assert_eq!(route_request(&cfg, &host("taxes.jasonmcaffee.com"), "/api/agent/stream").upstream_path, "/api/agent/stream");
    }

    #[test]
    fn sends_ai_socket_io_directly_to_the_backend() {
        assert_eq!(route_request(&config(), &host("ai.jasonmcaffee.com"), "/socket.io/?EIO=4&transport=polling").class, RouteClass::AiSocket);
    }
}
