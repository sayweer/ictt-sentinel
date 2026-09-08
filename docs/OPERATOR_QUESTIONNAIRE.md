# Operator questionnaire — ictt-sentinel pilot

Bu form bir satış beyanı değildir. Shadow pilot için gerekli gerçek deployment,
erişim, sahiplik ve operasyon kanıtını toplar. Secret **değeri**, private key,
mnemonic veya wallet bilgisi forma yazılmaz.

## Deployment ve sahiplik

1. Deployment adı ve iş sahibi kim?
2. Home ve remote Avalanche blockchainID'leri ile ayrı EVM chainId'leri nedir?
3. Genesis hash veya operatörce attested checkpoint hangisidir?
4. Home/remote kontrat adresleri ve deployment blokları nedir?
5. Onaylı manifest ve policy'yi kim, hangi tarihte gözden geçirecek?
6. Permissionless candidate remote kararının sahibi kim?

## RPC ve veri kapsamı

1. Her chain için providerGroup ve trustDomain listesi nedir? URL yerine isim ve
   ilişki yazın.
2. İki endpoint gerçekten farklı upstream, vendor ve failure domain mi?
3. Archive history deployment bloğuna kadar erişilebilir mi?
4. Accepted-state/finality davranışı hangi probe veya sağlayıcı belgesiyle
   doğrulandı?
5. Rate limit ve bakım penceresi nedir? İkinci provider aynı kotayı paylaşıyor mu?

## Protokol şekli

1. Canonical ERC20, native remote veya destek matrisindeki başka hangi şekil?
2. Messenger registry version ve source-locked ABI family nedir?
3. Proxy implementation/admin/beacon ve runtime code hash baseline'ları nelerdir?
4. Decimals, multiplier ve initial collateral davranışı doğrulandı mı?
5. Native ise genesis/upgrade config, minter roster, role-history başlangıcı ve
   precompile epoch'ları kim tarafından sağlanacak?

## Operasyon ve olay müdahalesi

1. CRITICAL ve UNKNOWN için birincil/ikincil sorumlu kim?
2. Acknowledgement paging'i sustururken verdict'in değişmediği kabul ediliyor mu?
3. Pause veya limit kararını hangi insan/multisig süreci alır?
4. Backup sıklığı, şifreleme, ayrı saklama yeri, RPO ve RTO nedir?
5. Restore ve raw-fact projection rebuild tatbikatını kim ve ne sıklıkla koşar?
6. Alert hedeflerinin secretRef adlarını kim yönetir?

## Paylaşım ve retention

1. Seçilen seviye: `local-only`, `sanitized-metadata` veya açık onaylı
   `approved-full`?
2. Raw fact, evidence bundle, audit log ve alert kaydı için ayrı retention
   süreleri nedir?
3. Private L1 verisini kimler görebilir ve erişim nasıl geri alınır?
4. Denetçiye hangi bundle/checksum teslim edilecek?

## Pilot kabul kaydı

- [ ] Read-only gerçek deployment erişimi doğrulandı.
- [ ] İki bağımsız providerGroup doğrulandı.
- [ ] Shadow replay ve ilk evidence üretildi.
- [ ] CRITICAL, UNKNOWN ve full-lab kontrollü demoları kaydedildi.
- [ ] Incident ve restore tatbikatı yapıldı.
- [ ] Sharing/retention kararı imzalı değişiklik kaydında.
- [ ] Paid-pilot intent var / yok. Varsa bağlantısı veya kayıt kimliği: ______

Eksik maddeler teknik preview kullanımını engellemez; `SHADOW_PILOT_READY` veya
ticari `GO` iddiasını engeller.
