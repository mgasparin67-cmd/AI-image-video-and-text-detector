// Runs only on the website's success page after paying on Stripe. Hands the checkout session to
// the service worker, which fetches the license key and unlocks Sloply in this browser, then
// tells the page so it can say so.

(() => {
  const sessionId = new URLSearchParams(location.search).get('session_id');
  if (!sessionId) return;
  chrome.runtime.sendMessage({ type: 'claimSession', sessionId }).then(result => {
    document.documentElement.dataset.slopless = result?.ok ? 'unlocked' : 'not-unlocked';
    document.dispatchEvent(new CustomEvent(result?.ok ? 'slopless:unlocked' : 'slopless:not-unlocked'));
  }).catch(() => {});
})();
