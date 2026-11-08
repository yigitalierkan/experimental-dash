# OnAir Filo & Rota Dashboard

OnAir Company verilerini [OnAir public API](https://server1.onair.company/swagger/index.html) üzerinden çekip GitHub Pages'te yayınlanan statik bir dashboard'a dönüştürür.

- **Filo** (`index.html`): kiralamadan bugüne uçak başına gerçekleşen gelir / sabit gider / değişken gider / net K/Z, uçak detayı, turnover/kullanım, son 24 saatte uçmamış uçaklar
- **Rotalar** (`routes.html`): Regular Routes listesi, harita üzerinde rotalar (great-circle), rotalara atanmış uçaklar ve performansları, filo konumları

## Nasıl çalışır

```
GitHub Actions (saatlik cron)
  └─ scripts/build.mjs  ── OnAir API (oa-apikey header) ──► ham snapshot
        └─ scripts/lib/metrics.mjs ──► site/data/dashboard.json, routes.json, debug.json
  └─ GitHub Pages'e deploy (site/)
```

API anahtarı yalnızca GitHub Actions secret'ı olarak kullanılır; tarayıcıya veya repoya hiç yazılmaz. Ziyaretçiler sadece hesaplanmış JSON'u görür.

## Kurulum

1. **Settings → Secrets and variables → Actions → Secrets**
   - `ONAIR_API_KEY` — **Virtual Airline**'ın API key'i (OnAir client → Virtual Airline → Settings)
   - `ONAIR_VA_ID` — Virtual Airline UUID'si (aynı ekranda)
   - *(Alternatif, şirket modu)* `ONAIR_COMPANY_ID` + şirket API key'i. `ONAIR_VA_ID` varsa o kullanılır.
2. (Opsiyonel) **Variables**
   - `IDLE_HOURS` — "uçmamış" eşiği, varsayılan `24`
   - `FLIGHT_DAYS` — kaç günlük uçuş geçmişi çekilsin, varsayılan `30`
3. **Actions → Update dashboard → Run workflow.** Secret'lar yoksa iş akışı demo veriyle yayınlar.

Pages adresi: `https://<kullanıcı>.github.io/<repo>/`

## Kullanılan endpoint'ler

VA modunda filo/uçuş/kasa uç noktaları `/companies/{vaId}/...` ile çağrılır (OnAir'de VA aynı zamanda bir şirket kaydıdır).

| Endpoint | Amaç |
|---|---|
| `GET /virtual_airlines/{vaId}` | VA adı/kodu (VA modu) |
| `GET /virtual_airlines/{vaId}/members` | VA üyeleri (VA modu) |
| `GET /companies/{id}` | şirket adı/kodu |
| `GET /companies/{id}/fleet` | filo, durum, konum |
| `GET /companies/{id}/flights?startIndex&limit` | son `FLIGHT_DAYS` günün uçuşları (sayfalı) |
| `GET /aircraft/{id}/flights` | uçak başına uçuşlar (en eski leasing başlangıcına kadar) |
| `GET /companies/{id}/cash_flow` | kasa defteri — uçak başına K/Z'nin kaynağı |
| `GET /companies/{id}/income_statement` | hesap adları (AccountId → Passenger Services, Fuel, …) |
| `GET /aircraft/{id}` | defterde geçen ama filoda olmayan (iade) uçakların tescili |
| `GET /regular_routes` | şirketin rotaları |
| `GET /airports/{icao}` | yalnızca koordinatı olmayan ICAO kodları için |

## Metrik tanımları

**Turnover / kullanım** (son 7 ve 30 gün, blok süresi = engine on → engine off)
- *Uçuş/gün*: pencere içindeki uçuş sayısı ÷ gün
- *Kullanım %*: blok saati ÷ (gün × 24)
- *Ort. turnaround*: ardışık iki uçuş arasındaki yerde kalma süresi (48 saatten uzun aralar sayılmaz)

**Uçak başına K/Z — kiralandığı günden bugüne** (projeksiyon yok, sadece gerçekleşen)

Kaynak: `/companies/{id}/cash_flow` kasa defteri. OnAir her satıra `AircraftId` yazar; gelir ve doğrudan giderler buna göre uçağa bağlanır.

| Grup | Kalemler | Uçağa bağlama |
|---|---|---|
| Gelir | Yolcu (Passenger Services), Kargo (Cargo Services) | `AircraftId` |
| Sabit | Leasing peşin + haftalık ödemeler, leasing iadesi, park ücreti | `AircraftId` / açıklamadaki tescil |
| Değişken | Yakıt, iniş ücreti, slot ücreti, bakım/atölye, uçağa ait cezalar | `AircraftId`; slot: "Flight #N" → rota → uçak |
| Genel gider payı | Personel/pilot ödemeleri, ekip otelleri, uçağa bağlanamayan ceza/slot, haftalık filo yönetimi | blok saat payına göre; filo yönetimi o tarihte filodaki uçaklara eşit |
| Hariç | Owner's equity, FBO yatırımları/sahiplik, FBO'ya alınan stok yakıt | şirket kalemi, uçağa yazılmaz |

Sayfadaki seçenekler:
- *Leasing maliyeti*: **Ödenen (nakit)** kasadan çıkan tutardır (peşin ödenen haftalar dahil). **Geçen süreye göre** ise haftalık bedel × kiralamadan bu yana geçen hafta.
- *Genel giderler*: uçaklara dağıt / hariç tut.

Uçak detayında kalem kırılımı, kümülatif gelir/gider/net grafiği, leasing bilgisi ve son kasa hareketleri yer alır. *Başabaş uçuş saati*: uçuş katkısının (gelir − değişken gider) haftalık leasing bedelini karşılaması için gereken haftalık blok saat. Filoda olmayan ama defterde geçen (iade edilmiş) uçaklar ayrı satırda gösterilir. Doğrudan link: `index.html#LZ-TVJ`.

**24 saattir uçmayanlar**: son uçuşun bitişinden bu yana ≥ `IDLE_HOURS` saat geçmiş ve şu an uçuşta olmayan uçaklar (hiç uçuş kaydı olmayanlar dahil).

## Yerelde çalıştırma

```bash
node scripts/build.mjs --mock                     # demo veri
ONAIR_API_KEY=... ONAIR_COMPANY_ID=... node scripts/build.mjs --save-raw
npm run serve                                     # http://localhost:8080
npm test
```

`site/data/debug.json`, API yanıtlarının alan adlarını ve ilk rota örneğini içerir. `/regular_routes` için swagger şeması olmadığından rota ayrıştırıcısı esnektir; bir şey eksik görünürse ilk bakılacak yer burası.

Harita: Leaflet 1.9.4 (`site/vendor`, BSD-2) + CARTO/OpenStreetMap karoları.
