# ADR-0001 — Anahtarsız ve salt-okunur mimari

- **Durum:** Kabul edildi
- **Tarih:** 2026-08-30
- **Milestone:** 00
- **İlgili:** `docs/SECURITY.md`, `docs/PRODUCT.md`, ADR-0003

---

## Bağlam

Ürün, ICTT deployment'larında teminat yeterliliği, muhasebe doğruluğu ve config değişmezliğini
denetler. Bu tür bir araç için doğal bir cazibe vardır: bir ihlal tespit edildiğinde **otomatik
müdahale** etmek — köprüyü durdurmak, bir mesajı yeniden denemek, limit uygulamak.

Bunu yapabilmek için ürünün bir signer'a, dolayısıyla bir private key'e sahip olması gerekir.

Ayrıca operatörle entegrasyonu kolaylaştırmak için "her şeyi yapabilen" bir generic RPC
passthrough (`request(method, params)`) sunmak da caziptir.

## Karar

**Ürün hiçbir koşulda private key tutmaz, imzalamaz, göndermez veya durdurmaz.**

1. Private key, mnemonic, seed, signer, wallet, keystore **oluşturulmaz, istenmez, saklanmaz,
   okunmaz**.
2. `sendTransaction`, signer interface veya herhangi bir **chain-write yüzeyi** eklenmez.
3. mint / burn / retry / pause / upgrade çağrısı **yapılmaz**.
4. **Auto-pause ve otomatik devre kesici yoktur.**
5. **Public generic `request(method, params)` RPC yüzeyi yasaktır.** Yalnız query-only
   allowlist: okunan her JSON-RPC method adı kod içinde sabit listede bulunur. Yazma yapan
   hiçbir method allowlist'e giremez.
6. Agent → hosted plane yalnız **signed-ingestion token** kullanır; chain signing key yoktur.
7. MVP'de `BRIDGE_PRIVATE_KEY`, `MINTER_PRIVATE_KEY`, `PAUSER_PRIVATE_KEY`,
   `MULTISIG_SIGNER_KEY` varlığı **build hatası** üretir.

## Gerekçe

**1. Yanlış müdahalenin beklenen zararı, kaçırılan müdahalenin zararından büyüktür.**
Yanlış bir `pause` çağrısı, gerçek bir ihlal olmadan üretimi durdurur ve doğrudan finansal
zarar üretir. Bu ürün özellikle `UNKNOWN` üreten koşullarda (RPC ayrışması, log gap, tanınmayan
fingerprint) çalışır — yani en çok yanılabileceği anlar, müdahalenin en tehlikeli olduğu anlardır.

**2. Bir güvenlik aracı, koruduğu sistemin saldırı yüzeyini büyütmemelidir.**
Pause yetkisi olan bir izleme aracı, saldırgan için köprünün kendisinden daha çekici bir hedeftir:
tek bir servisi ele geçirerek üretimi durdurabilir.

**3. Alıcının güvenlik incelemesini geçmek.**
Hedef müşteri (L1 CTO, security lead) bir üçüncü taraf aracına signing yetkisi vermez.
"Signing key istemiyoruz" cümlesi bir kısıt değil, **satış argümanıdır** — kurulum sürtünmesini
ve güvenlik inceleme süresini dramatik biçimde düşürür.

**4. Sorumluluk sınırı nettir.**
Pause/limit kararı insan onaylı multisig sürecinde alınır. Sentinel delili üretir, kararı
üretmez. Bu, hem hukuki hem operasyonel olarak savunulabilir tek konumdur.

**5. Generic RPC passthrough anahtarsızlığı dolaylı olarak deler.**
Operatörün RPC credential'ı üzerinden keyfi method çağrısına izin veren bir yüzey, ürünün
"salt-okunur" sözünü şema düzeyinde değil yalnız niyet düzeyinde tutar ve SSRF benzeri bir
pivot noktası yaratır.

## Sonuçlar

### Olumlu

- Güvenlik incelemesi ve kurulum süresi kısalır
- Ürünün ele geçirilmesi köprüyü durduramaz
- Hukuki sorumluluk yüzeyi dar kalır
- `UNKNOWN` üretmek güvenli bir davranıştır — müdahale riski yoktur

### Olumsuz / kabul edilen maliyet

- "Otomatik koruma" isteyen alıcıya bu ürün tek başına yetmez
- Response otomasyonu isteyen segment ayrı bir ürün/katman gerektirir
- Rakipler (Phalcon, Hypernative) auto-block pazarlayabilir; bu rekabette bilinçli olarak
  yarışmıyoruz

### Gelecekteki response katmanı

Talep gelirse, response **ayrı bir ürün** olarak, **opt-in** ve **multisig policy altında**
tasarlanır. Bu ADR'yi geçersiz kılmaz: sentinel yine imzalamaz; yalnız imzalayan ayrı bir
bileşene delil sunar.

## Alternatifler ve neden reddedildi

| Alternatif | Neden reddedildi |
|---|---|
| Auto-pause ile tam koruma | Yanlış pause riski çok yüksek; alıcı güvenlik incelemesini geçmez |
| "Sadece testnet'te signing" | Kod yolunda signer bulunması sınırı yumuşatır; kaza riski |
| Opsiyonel signer (flag ile) | Flag'ler açılır; sözün kendisi ölçülemez hale gelir |
| Generic RPC passthrough | Anahtarsızlığı dolaylı deler; SSRF pivot yüzeyi |

## Doğrulama

- Yasak env taraması testi (`docs/TEST_STRATEGY.md` §6)
- RPC allowlist testi: allowlist dışı ve yazma method'ları reddedilir
- Kabul eşiği: "Zincir signing key'i yok; secret leakage testi geçer"
