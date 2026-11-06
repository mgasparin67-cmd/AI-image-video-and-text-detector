// The never-check list (settings key disabledSites): sites where the extension does nothing.
// An entry covers the site and its subdomains: "example.com" also covers "www.example.com" and
// "blog.example.com". Entries can be pasted as full addresses; they're reduced to the host name.
// Used by the page scripts, the Google Docs script, the popup and the settings page.

(function (root) {
  // "https://www.Example.com/path" -> "www.example.com"; "*.example.com" -> "example.com".
  function normalize(entry) {
    let s = String(entry || '').trim().toLowerCase();
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*\./, '').replace(/\.$/, '');
    return /^[a-z0-9.-]+$/.test(s) && s.includes('.') || s === 'localhost' ? s : '';
  }

  const matches = (host, entry) => host === entry || host.endsWith('.' + entry);

  // Whether a host is on the list.
  const isListed = (host, list = []) => !!host && list.some(e => matches(host.toLowerCase(), normalize(e)));

  // The list without the entries that cover a host (for "Resume" in the popup).
  const without = (host, list = []) => list.filter(e => !matches(host.toLowerCase(), normalize(e)));

  root.AIBSites = { normalize, isListed, without };
})(typeof window !== 'undefined' ? window : self);
