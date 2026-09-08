# Backup, restore ve migration — ictt-sentinel

Bu prosedürler `infra/postgres/docker-compose.yml` ile ayağa kalkan yerel
PostgreSQL'e karşı **gerçekten çalıştırıldı** (M14 tatbikatı). Komutlar
kopyalanabilir; ölçümler o tatbikattan.

Saklama politikası `docs/RUNBOOK.md` §5'tedir ve burada tekrarlanmaz.

---

## 1. Rol ve sahiplik ön koşulu

Migration'ın çalışması için veritabanının **`ictt_sentinel_migrator` rolüne ait
olması** gerekir. PostgreSQL 15+ `public` şemasında `CREATE`'i `PUBLIC`'ten
geri aldığı için, `postgres` kullanıcısına ait bir veritabanında
`SET LOCAL ROLE ictt_sentinel_migrator` sonrası migration
`permission denied for schema public` ile düşer.

Tatbikatta bu hata gerçekten görüldü ve nedeni buydu. Doğru sıra:

```bash
# 1. Grup rollerini bir kez oluştur (superuser bağlantısı gerekir)
ICTT_SENTINEL_DATABASE_URL='postgres://<superuser>@<host>/postgres' \
  node packages/storage-postgres/dist/cli.js --bootstrap-roles

# 2. Veritabanını migrator rolüne ait olarak yarat
psql -c 'CREATE DATABASE ictt_sentinel OWNER ictt_sentinel_migrator'
```

`--bootstrap-roles` küme başına bir kezdir. Uygulama bunu **kendi başlangıcında
çalıştırmaz**: kendini migrate eden bir servis, her süreçte sonsuza kadar DDL
yetkili bir credential ister.

---

## 2. Migration ileri

```bash
ICTT_SENTINEL_DATABASE_URL='postgres://<migrator-login>@<host>/ictt_sentinel' \
  node packages/storage-postgres/dist/cli.js
```

Tatbikat çıktısı:

```
migrate <host>/ictt_m14_drill: applied [1, 2, 3, 4, 5, 6, 7, 8], already applied []
real 0.19s
```

İkinci çalıştırma idempotenttir:

```
migrate <host>/ictt_m14_drill: applied [], already applied [1, 2, 3, 4, 5, 6, 7, 8]
real 0.11s
```

**Uygulanmış bir migration değişmezdir.** Dosyası değiştiyse runner
`MigrationDriftError` verir ve checksum'ı "onarmaz": veritabanı eski şekli
zaten almıştır ve onu ancak yeni bir migration ileri taşıyabilir.

Geri alma (down migration) **yoktur**. Şema ileri gider; geri dönüş yolu
restore'dur (§4).

---

## 3. Yedek

```bash
pg_dump -U <user> -d ictt_sentinel -Fc -f ictt_sentinel-$(date -u +%Y%m%dT%H%M%SZ).dump
```

Son tatbikat: 8 migration uygulanmış boş şema için `91553` bayt.

Yedek **şifrelenerek** ve veritabanı sunucusundan ayrı bir yerde saklanır.
İçinde credential yoktur — `rpc_endpoints` tablosu env değişkeni **adı** tutar,
değerini değil — ama gözlenmiş zincir verisi vardır ve private L1 için bu
hassas olabilir.

---

## 4. Restore tatbikatı

Restore **hedef veritabanını yaratmaz** ve sahiplik yine gereklidir:

```bash
psql -c 'CREATE DATABASE ictt_sentinel_restore OWNER ictt_sentinel_migrator'
pg_restore -U <user> -d ictt_sentinel_restore \
  --no-owner --role=ictt_sentinel_migrator ictt_sentinel-<stamp>.dump
```

Tatbikat: `0.11 s`. Doğrulama:

```bash
psql -d ictt_sentinel_restore -tAc \
  'select version || $$:$$ || name from schema_migrations order by version'
```

Beklenen çıktı, yedek alındığı andaki migration tarihçesinin tamamı:

```
1:raw_fact_ledger
2:verdicts_and_jobs
3:runtime_privileges
4:replay_recovery
5:message_transition_vocabulary
6:alerting_and_hosted_plane
7:hosted_evidence_records
8:alert_recovery_outbox_status
```

### 4.1 Restore sonrası zorunlu kontroller

`docs/RUNBOOK.md` §4 bağlayıcıdır. Kısaca:

1. **Checkpoint kanıtından ileri olmamalı.** Her `(deployment, chain)` için
   `replay_checkpoints.last_block_number`, o zincirin depodaki en yüksek
   accepted bloğundan büyük **olmamalıdır**. Büyükse checkpoint kanıtını
   aşmıştır: **durdur, ileri sarma, `UNKNOWN` raporla.**
2. **Projection'ları yedekten güvenilir sayma.** `rebuildTransferTotals` ile ham
   fact'lerden yeniden kur ve dönen `sourceDigest`'i yedek öncesi kayıtla
   karşılaştır.
3. **`integrity_incidents` boş değilse** hiçbir yeşil hüküm verilmeden önce
   insan incelemesi gerekir.
4. Restore edilmiş veritabanına karşı bir değerlendirme koş ve evidence
   bundle'ının content hash'ini yedek öncesi bundle ile karşılaştır. Aynı
   pinned bloklar ve aynı rule version aynı digest'i vermelidir.

---

## 5. Neyin yedeklenmesi gerekmez

| Veri | Neden |
|---|---|
| `projection_*` | Türetilmiş. Ham fact'lerden yeniden kurulur ve yedekten **güvenilir sayılmaz**. |
| `api_idempotency`, `webhook_nonces` | TTL'li operasyonel durum. Kaybı en fazla bir tekrarlanan isteğe mal olur. |
| `dist/`, `dist-web/`, `artifacts/` | Kaynaktan yeniden üretilir; `artifacts/` zaten repository'de. |

Yedeklenmesi **zorunlu** olan: ham fact tabloları, hüküm tabloları,
`integrity_incidents`, `schema_migrations` ve operatörce yönetilen referans
verisi (`deployments`, `chains`, `rpc_endpoints`, `contract_baselines`,
`tenants`, `deployment_tenants`, `api_tokens`).

---

## 6. Felaket senaryosu: veritabanı tamamen kayıp

Nöbetçi bu durumda **yeniden inşa edilebilir** — bu tasarımın sonucudur:

1. Rolleri ve veritabanını §1'e göre yarat, §2 ile migrate et.
2. Referans verisini onaylanmış manifest'ten yeniden yükle.
3. `ictt-sentinel replay --manifest ... --policy ...` ile deployment bloğundan
   yeniden oynat. Replay bounded, pinned ve resumable'dır.
4. Yeniden inşa tamamlanana kadar hüküm `UNKNOWN`'dır ve öyle raporlanır.
   Eksik geçmişle `OK` verilmez.

Kaybedilen tek şey **geçmiş kanıt kaydıdır**: daha önce dışa aktarılmış evidence
bundle'ları yeniden üretilemez, çünkü onlar o anki pinned bloklara aittir. Bu
yüzden bundle'lar veritabanının dışında, release gate'inde saklanır.
