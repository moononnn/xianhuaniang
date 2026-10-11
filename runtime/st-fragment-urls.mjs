/** HTML 片段解析不会调用 img.src/setAttribute；在欢迎页插入片段前补齐受管地址。 */
export function installFragmentImageUrls(scope) {
  const match = scope.location.pathname.match(/^(\/api\/apps\/[^/]+\/routes\/_runtime\/[^/]+\/_surface\/[^/]+\/)/);
  if (!match || !scope.Range?.prototype?.createContextualFragment) return;
  const base = match[1];
  const native = scope.Range.prototype.createContextualFragment;
  if (native.hanabrewFragmentImages) return;
  function createContextualFragment(...args) {
    const fragment = native.apply(this, args);
    for (const image of fragment.querySelectorAll('img[src]')) {
      const value = image.getAttribute('src');
      if (!value?.startsWith('/') || value.startsWith('//') || value.startsWith(base)) continue;
      const url = new scope.URL(value, scope.location.href);
      url.pathname = base + url.pathname.slice(1);
      image.setAttribute('src', url.href);
    }
    return fragment;
  }
  createContextualFragment.hanabrewFragmentImages = true;
  scope.Range.prototype.createContextualFragment = createContextualFragment;
}

export const FRAGMENT_URL_SCRIPT = `<!-- HANABREW_FRAGMENT_IMAGE_URLS -->
<script>(${installFragmentImageUrls.toString()})(window);</script>`;
