# ADR-0009 — Operatör konsolu stack'i

- **Durum:** `ACCEPTED`
- **Tarih:** 2026-09-08
- **Milestone:** 13
- **İlgili:** ADR-0001 (keyless read-only), ADR-0008 (hosted API stack), `docs/SECURITY.md`

## Bağlam

Milestone 13 salt-okunur bir operatör konsolu istiyor. `docs/ARCHITECTURE.md` §6 MVP teknoloji
tablosunda konsol için bir seçim yok; prompt "React + TypeScript tabanlı **en küçük uygun** stack"
değerlendirmesi istiyor.

Karşı ağırlık ADR-0008'dekiyle aynı: bu anahtarsız bir güvenlik aracı. Fastify'ın +47 paketi
"repository'deki en büyük tek trust-boundary genişlemesi" olarak kayda geçmişti. Bir frontend
stack'i bunu kolayca ikiye katlayabilir.

## Karar

**React `19.2.8` + react-dom `19.2.8`, bundler olarak Vite `8.2.2`, E2E için `@playwright/test`
`1.63.0`, component testleri için `happy-dom` `20.14.0`. Hepsi exact pin.**

Resmî registry'den okunan engine alanları Node 24.20.0 ile uyumlu (`vite`: `^20.19.0 || >=22.12.0`,
`@playwright/test`: `>=20`, `happy-dom`: `>=20`). `vitest@4.1.11` Vite `^6 || ^7 || ^8` kabul
ediyor, yani workspace'te tek bir Vite 8 var; sürüm çakışması yok.

Toplam maliyet **+19 paket**: runtime'a giren yalnız 3'ü (`react`, `react-dom`, `scheduler`).
Hiçbirinde install lifecycle script'i yok; `.npmrc` zaten `enable-pre-post-scripts=false`.

### Neden framework plugin'i yok

`@vitejs/plugin-react` **kurulmadı**. Tek getirisi dev-server Fast Refresh ve React Compiler;
konsol dev server çalıştırmıyor, JSX dönüşümünü Vite 8 (rolldown/oxc) tsconfig'teki
`"jsx": "react-jsx"` ile zaten yapıyor. Plugin'in peer'ları (`oxc-transform-react`,
`@rolldown/plugin-babel`, `babel-plugin-react-compiler`) sırf HMR için trust boundary'ye girecekti.

### Neden router ve state kütüphanesi yok

Hash routing 90 satırlık saf bir parser (`src/model/route.ts`), state `useState`. Konsol yedi
sayfalık salt-okunur bir görüntüleyici; bir router kütüphanesi burada çözdüğünden fazla yüzey ekler.

### Neden `dist` değil `dist-web`

`dist` `tsc --build`'e ait ve `verify:scaffold` orayı denetliyor. İki build sisteminin tek dizine
yazması, en kötü anda ayıklanacak bir yarış demektir.

## Güvenlik kararları

### Token: yalnız bellek

Bearer token sekme belleğinde tutulur. **`localStorage` yok, cookie yok, URL parametresi yok, log
yok.** Tehdit modeli: konsolda bir XSS varsa `localStorage`'daki token sekme kapansa bile
çalınabilir; bellekteki token yalnız o sekme yaşarken risktir. Bedeli her reload'da yeniden
girmektir — kabul edildi. Alternatif olarak konsol, header'ı kendisi ekleyen bir authenticating
reverse proxy arkasına konabilir; bu README'de yazılı.

### Same-origin

`ApiClient` mutlak URL kabul etmez; yalnız same-origin path prefix alır ve bunu constructor'da
doğrular. `mode: 'same-origin'`, `credentials: 'omit'`, `redirect: 'error'`. Böylece
`connect-src 'self'` bir temenni değil, kodun yapısal sonucu.

### CSP

`index.html` içinde meta CSP: `default-src 'none'; script-src 'self'; style-src 'self';
img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none';
frame-ancestors 'none'; object-src 'none'`.

Meta etiketi artefaktla birlikte taşınsın diye var. **Sunucu ayrıca gerçek header göndermelidir**;
meta ile ifade edilemeyenler:

```
Content-Security-Policy: <yukarıdakiyle aynı>
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000; includeSubDomains
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=()
```

### Source map: yayınlanmaz

`build.sourcemap: false`. Bir güvenlik aracının tam kaynağını her tarayıcıya göndermek gereksiz bir
keşif kolaylığı. Hata ayıklama gerekiyorsa map'ler CI'da üretilip ayrı saklanır, artefaktla
dağıtılmaz. `scripts/verify-bundle.mjs` bir `.map` dosyası bulursa kapıyı düşürür.

### Bundle denetimi

`verify:bundle` **kaynağı değil, üretilmiş artefaktı** tarar: Node-only referans, credential şekli,
off-origin URL, eksik CSP direktifi ve source map. Kendi pattern'lerini her çalıştırmada self-test
eder.

Bu denetim bir gerçek hatayı ilk çalıştırmada yakaladı: `@ictt-sentinel/config`'i import etmek
`node:crypto`'yu tarayıcı bundle'ına sokuyordu. Çözüm bağımlılığı kaldırmaktı — konsol artık
`config`'e bağlı değil ve onboarding'in secret-şekli kontrolü kendi dar guard'ı.

İki tür URL beyaz listede, tek tek gerekçeli: React'ın `react.dev/errors/` hata mesajı öneki ve
react-dom'un `createElementNS` için kullandığı W3C **namespace identifier**'ları. İkisi de metin,
hedef değil.

### Tarayıcı zincire bağlanmaz

Konsolda RPC istemcisi, wallet bağlantısı, signer ve transaction gönderen hiçbir yüzey yok.
`scripts/check-boundaries.mjs` bu turda `.tsx` dosyalarını da tarayacak şekilde genişletildi —
aksi halde bir component dosyası bu kapıya görünmez olurdu.

## Sonuçlar

**Kabul edilen:**

- Konsol statik bir artefakt; hosted API'yi fronte eden host onu da servis eder.
- Tarayıcıda kriptografik doğrulama **yok**. `packages/evidence` `node:crypto` kullanıyor ve onu
  Web Crypto'ya taşımak M11 paketinin mimarisini değiştirmek olurdu. Konsol API'nin kaydettiği
  `verifyStatus`'u gösterir ve bağımsız doğrulamanın CLI ile offline yapılacağını söyler. Zaten
  doğru güven modeli bu: bir tarayıcının kendi kendine "hash'i doğruladım" demesi az şey kanıtlar.
- Konsolun görebildiği her şey tenant-scoped token ile sınırlıdır ve yetkilendirmeyi **sunucu**
  uygular; UI'ın gizlemesi bir kontrol değildir.

**Bedeli:**

- 19 paketlik bir ağaç geliştirme zincirine, 3'ü runtime'a girdi.
- Playwright tarayıcı ikilisi (Chrome Headless Shell ~94 MiB) geliştirici makinesinde ayrıca
  kurulur; `pnpm run verify` bunu gerektirmez, E2E ayrı bir kapıdır.
- Vite 8 yeni bir majör; `@vitejs/plugin-react` gerekirse peer zinciri yeniden değerlendirilmeli.

## Yeniden gözden geçirme

React majör sürüm değişiminde, Vite majör değişiminde, bir güvenlik duyurusunda veya konsol
kapsam dışına çıkarsa bu ADR yeniden değerlendirilir.
