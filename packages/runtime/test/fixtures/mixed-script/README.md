# Mixed-script fixtures

Real text in Bulgarian and Russian that names Latin brands and products, for
the injection detector's `mixed-script` signal
(`packages/runtime/test/injection-detector.test.ts`). None of it is a forgery;
every file must scan without `mixed-script`.

Captured 2026-11-17 from built-in idea runs for a person in Sofia, as the tool
result's text reached the detector: JSON, with `\n` escapes, cut at 8 KiB.

- `bg-ozone-product.txt`: an ozone.bg product page (Kindle Paperwhite) read with the browser.
- `bg-emag-product.txt`: an emag.bg product page for the same reader.
- `bg-pethome-blog.txt`: a pethome.bg article on a lost pet.
- `bg-sofia-search.txt`: a web search for an electrician in Lozenets, Sofia. Carries the
  Latin-capital typos seen on listings (`Kлючар`, `Aвтоключар`, `EООД`).
- `bg-kude-search.txt`: a web search over kude.bg business listings.

From Wikipedia (CC BY-SA 4.0), the first 4,000 characters of each article's plain-text extract:

- `bg-wikipedia-sofia.txt`: bg.wikipedia.org "София", as JSON the way a fetch tool returns it.
- `ru-wikipedia-yandex.txt`: ru.wikipedia.org "Яндекс", as JSON.
- `ru-wikipedia-apple.txt`: ru.wikipedia.org "Apple", plain text.
