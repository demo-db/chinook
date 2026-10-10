// The OVDB Directory's own rules for what a manifest publishes, ported for the offline pre-check
// (CC0-1.0, like the Directory's files).
//
// MIRRORS `scripts/lib/urls.mjs` and `scripts/lib/directory.mjs` of openvaultdb/directory: publicHttpsProblem,
// hostProblem and homepageProblem are copied from urls.mjs (the file's opening comment is not repeated; it
// includes the refusal of any port, even :443, and of any percent escape in a path except the one encoded native
// name of a generated recordset page: encodePathSegment and the encodedPathSegment option of publicHttpsProblem),
// and from directory.mjs
// the generic canonical-identity URL rule, id pattern, deployment.engine pattern and `homepage` field check,
// and from git.mjs isRepositoryPath. When the Directory changes one of them, change it here. Tests pin the
// accepted canonical identity forms and unsafe URL refusals.

// ---- scripts/lib/urls.mjs ----

// Names that are never public: local, internal and reserved naming zones.
const privateSuffixes = [
  'localhost', 'local', 'internal', 'localdomain', 'lan', 'home.arpa', 'arpa', 'intranet', 'corp', 'private',
  'svc', 'home', 'test', 'example', 'invalid', 'onion',
];

// Two-label public suffixes where the registered name sits one label further left
// (ovdb.co.uk is a registered name under co.uk, not a subdomain). The list is short: 17
// of the common ones, kept by hand, not the public suffix list. How it is decided: a
// suffix is added by a reviewed change to this list when a real publisher needs it. Until
// then a name under a suffix that is not listed counts as having `ovdb` as a subdomain
// (ovdb.co.il, ovdb.com.sg, ovdb.github.io and ovdb.pages.dev pass although `ovdb` is
// the registered name, or a publisher's own site, there). That is acceptable because
// the marker is a naming convention, not proof that the publisher owns the origin (see
// the README).
// A problem with the host of `url` for a public mapping, or null.
export function hostProblem(url) {
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || host.includes(':')) return `${url.hostname} is an IP address; a public mapping names a host`;
  if (host.endsWith('.')) return `${url.hostname} ends with a dot; write the host without it`;
  if (host.split('.').some((label) => label === '')) return `${url.hostname} has an empty label`;
  if (/^\d+(\.\d+)*$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return `${url.hostname} is an IP address; a public mapping names a host`;
  if (!host.includes('.')) return `${url.hostname} is a single-label name, not a public host`;
  for (const suffix of privateSuffixes) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return `${url.hostname} is a local, internal or reserved name (.${suffix}), not a public host`;
  }
  return null;
}

// The one spelling of a native recordset name as a path segment: encodeURIComponent, with the five characters it leaves
// alone (! ' ( ) *) encoded too. The Directory writes a recordset page this way (urls.mjs encodePathSegment).
export const encodePathSegment = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.codePointAt(0).toString(16).toUpperCase()}`);

// A problem with `value` as a public https URL (the canonical url, the
// deployment's url, discovery document or recordset page, the publisher's
// url), or null. `template` allows `{name}` exactly once, and only in the path
// (never in the host, userinfo or port), as in recordset_page.
// Refused: anything but https, userinfo, a query, a fragment, a host that is
// not public (see hostProblem), a malformed or non-canonical spelling.
// `encodedPathSegment` is the one percent-encoded native recordset name that a generated recordset URL may carry (what
// encodePathSegment gives a name that has a character to encode); any other percent escape in the path is refused.
export function publicHttpsProblem(value, { template = false, encodedPathSegment } = {}) {
  if (typeof value !== 'string' || value.trim() === '') return 'is not a URL';
  if (value !== value.trim() || /[\u0000- \u007f\\]/.test(value)) return 'contains whitespace, control characters or a backslash';
  let probe = value;
  if (template) {
    if (value.split('{name}').length !== 2) return 'must contain {name} exactly once';
    const authorityEnd = value.indexOf('/', value.indexOf('//') + 2);
    if (authorityEnd === -1 || value.indexOf('{name}') < authorityEnd) return 'must have {name} in the path only, never in the host, userinfo or port';
    probe = value.replace('{name}', 'name');
  }
  let url;
  try { url = new URL(probe); } catch { return 'is not a URL'; }
  if (url.protocol !== 'https:') return `must be https, not ${url.protocol.slice(0, -1)}`;
  if (url.username || url.password) return 'must not contain credentials (userinfo)';
  if (url.search || probe.includes('?')) return 'must not contain a query';
  if (url.hash || probe.includes('#')) return 'must not contain a fragment';
  const problem = hostProblem(url);
  if (problem) return problem;
  // The parser drops the default port, so look at the text: any ":" in the authority is a port.
  if (probe.slice('https://'.length).split('/')[0].includes(':')) return 'must not name a port (not even :443): a deployment is reached on the default https port';
  if (url.pathname.includes('//')) return 'has an empty path segment (//)';
  const authorityEnd = probe.indexOf('/', probe.indexOf('//') + 2);
  const writtenPath = authorityEnd === -1 ? '' : probe.slice(authorityEnd);
  if (writtenPath.includes('%')) {
    const escaped = writtenPath.split('/').filter((segment) => segment.includes('%'));
    const allowedEscapes = typeof encodedPathSegment === 'string' ? [encodedPathSegment] : [];
    if (escaped.length !== allowedEscapes.length || escaped.some((segment, index) => segment !== allowedEscapes[index])) {
      return 'must not contain a percent escape in the path (write the character itself, or leave it out)';
    }
    for (const encoded of escaped) {
      let decoded;
      try { decoded = decodeURIComponent(encoded); } catch { return 'has an invalid percent escape in the path'; }
      if (encodePathSegment(decoded) !== encoded || decoded === '.' || decoded === '..' || /[/\\\u0000-\u001f\u007f]/.test(decoded)) {
        return 'has a non-canonical or unsafe encoded path segment';
      }
      // A downstream router or proxy must not be able to turn a still-encoded separator or dot segment into path syntax
      // by decoding this segment a second (or later) time. Check each nested layer without changing the spelling.
      let nested = decoded;
      while (/%[0-9a-f]{2}/i.test(nested)) {
        let next;
        try { next = decodeURIComponent(nested); } catch { break; }
        if (next === nested) break;
        if (next === '.' || next === '..' || /[/\\\u0000-\u001f\u007f]/.test(next)) {
          return 'has a nested percent escape that can become a path separator, control character or dot segment';
        }
        nested = next;
      }
    }
  }
  // The literal text must be the URL's own spelling, so that what is checked is
  // what is published (no %2e dot segments, no mixed-case host, no decoded host).
  if (url.href !== probe) return `is not written canonically (it would be ${url.href})`;
  return null;
}

// What the index guarantees about a manifest's `homepage`, on top of publicHttpsProblem (https, no
// userinfo, query or fragment, no port, a public host written canonically): at most 200 characters; a
// lower-case host of two or more dot-separated labels of ASCII letters, digits and hyphen (no label starts
// or ends with a hyphen); a path of only A-Z a-z 0-9 . _ ~ / - (no percent escape, no quote, ampersand or
// other punctuation). A site that shows the value must still HTML-escape it, and must not put it in a
// single-quoted or unquoted attribute.
export const homepageMaxLength = 200;
const homepageLabel = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export function homepageProblem(value) {
  const problem = publicHttpsProblem(value);
  if (problem) return problem;
  if (value.length > homepageMaxLength) return `is longer than ${homepageMaxLength} characters`;
  const url = new URL(value);
  const labels = url.hostname.split('.');
  if (labels.length < 2 || !labels.every((label) => homepageLabel.test(label))) return `host ${url.hostname} must be lower-case labels of ASCII letters, digits and hyphen (none starting or ending with a hyphen), at least two, separated by dots`;
  if (!/^[A-Za-z0-9._~/-]*$/.test(url.pathname)) return 'path may only use A-Z a-z 0-9 . _ ~ / and - (no quote, ampersand, percent escape or other punctuation)';
  return null;
}

// ---- the rule for every URL field of a manifest ----

const urlLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const urlPath = /^[A-Za-z0-9._~/-]*$/;

// A problem with `value` as a URL a manifest publishes, or null: publicHttpsProblem (the Directory's rule) and, on top
// of it, one plain spelling for every URL field, so that it is text that needs no escaping in an HTML attribute, a JSON
// string or a command line, whatever a page does with it: a host of lower-case ASCII letters, digits and hyphen in
// dot-separated labels (1 to 63 characters each, none starting or ending with a hyphen, at least two, 253 characters in
// all, no trailing dot); no port; a path of only A-Z a-z 0-9 . _ ~ / and - (and, with `template`, the one literal {name}
// of recordset_page), no percent escape, no `//`, no dot segment. This is at least as strict as the Directory's rule,
// and stricter wherever that is looser; the 200-character cap is homepage's alone.
export function manifestUrlProblem(value, options = {}) {
  const problem = publicHttpsProblem(value, options);
  if (problem) return problem;
  const [, authority, path] = /^https:\/\/([^/]*)(\/.*)$/.exec(value) ?? [];
  if (authority === undefined) return 'must be https://<host>/<path>';
  const labels = authority.split('.');
  if (authority.length > 253 || labels.length < 2 || !labels.every((label) => urlLabel.test(label))) return `host ${authority} must be lower-case ASCII letters, digits and hyphen in dot-separated labels (1 to 63 characters each, none starting or ending with a hyphen, at least two, 253 characters in all)`;
  const plainPath = options.template ? path.replace('{name}', '') : path;
  if (!urlPath.test(plainPath)) return 'path may only use A-Z a-z 0-9 . _ ~ / and - (no quote, ampersand, parenthesis, percent escape or other punctuation)';
  return null;
}

// ---- scripts/lib/directory.mjs and scripts/lib/git.mjs ----

// A problem with `value` as a database's canonical identity, or null. Identity paths may be at the root,
// nested, and may end in a slash; safety and canonical spelling are enforced by manifestUrlProblem.
export function canonicalUrlProblem(value) {
  return manifestUrlProblem(value);
}

// A problem with the manifest's `homepage` as the Directory checks the field, or null.
// The Directory's own homepage rule first, then the plain spelling every URL field has (label lengths, host length).
export const homepageFieldProblem = (value) => (typeof value === 'string' && value !== '' ? homepageProblem(value) ?? manifestUrlProblem(value) : 'is not a URL (leave homepage out when the database has no website)');

// A database id: the record key and the manifest's id.
export const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const maxIdLength = 80;
export const enginePattern = /^[A-Za-z][A-Za-z0-9_.+-]{0,39}$/;

// A path inside a repository: relative, no "..", no glob characters.
const filePathPattern = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*(?:^|\/)\.(?:\/|$))[A-Za-z0-9_.\/-]+$/;
export const isRepositoryPath = (path) => typeof path === 'string' && filePathPattern.test(path) && !path.endsWith('/');
