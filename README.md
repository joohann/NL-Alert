# NL-Alert voor Home Assistant

Custom integration die actieve NL-Alert waarschuwingen ophaalt en doorgeeft
aan je huis: alarm door de speakers, een gesproken aankondiging, een kritieke
notificatie op je telefoon en het gewaarschuwde gebied op een kaart.

> Onofficieel. Dit project heeft geen band met de Rijksoverheid of het
> ministerie van Justitie en Veiligheid. Gegevens komen van de publieke API van
> [public-warning.app](https://api.public-warning.app). **Vertrouw hier nooit
> alleen op** — NL-Alert op je telefoon en de sirene blijven leidend.

## Functionaliteit

- **Alarmeert bij wat jou aangaat** — een alert waarvan het gebied jouw locatie
  bevat, een landelijke melding, of een test. Een incident twee provincies
  verderop wordt wel getoond en gelogd, maar blijft stil.
- **Straal instelbaar** — de feed tekent gebieden rond het incident, niet rond
  adressen. Met een straal in km telt een brand net buiten de grens ook mee.
  De afstand tot de rand van het gebied staat bij elke melding.
- **Tweetalig** — een NL-Alert is Nederlands en meestal Engels na `***`. Beide
  worden uitgesproken, elk in de eigen taal. Ontbreekt het Engels, dan kan het
  vertaald worden via HA's eigen `ai_task` (welke LLM je ook gebruikt).
- **Eigen alarmgeluiden** — zes meegeleverde tonen, waaronder een slow whoop.
  Geen verwijzingen naar bestanden van andere integraties.
- **Sirene** — koppel een `siren`- of `switch`-entiteit die tegelijk met het
  alarmgeluid afgaat, ook als je helemaal geen speakers hebt. Standaard loopt
  hij precies even lang als het geluid; die lengte wordt uit het bestand
  gelezen.
- **Nachtmodus** — zachter volume binnen een tijdvenster, met eventueel een
  ander geluid.
- **Kritieke notificaties** — iOS critical alert en Android alarm-stream. Voor
  toestellen die de alarm-stream negeren (veel Samsungs) is er per toestel een
  gesproken variant.
- **Naar de TV** — cast een Lovelace-view naar een Chromecast, inclusief de TV
  eerst aanzetten.
- **Maandelijkse test** — eerste maandag van de maand om 12:00:00, overgeslagen
  op feestdagen.
- **Paneel met kaart** — landelijk overzicht, geschiedenis met locatie, slepen,
  zoomen en dubbelklikken. De kaartlaag is instelbaar: OpenStreetMap, Esri, of
  je eigen tegel-URL.
- **Eigen brand-icoon** (via de lokale `brand/` map, geen PR naar de
  home-assistant/brands-repo nodig).

## Installatie

### Via HACS (custom repository)

1. HACS > drie stipjes rechtsboven > **Custom repositories**.
2. Voeg `https://github.com/joohann/NL-Alert` toe met categorie **Integration**.
3. Zoek "NL-Alert" in HACS en installeer.
4. Herstart Home Assistant.

### Handmatig

1. Kopieer de map `custom_components/nl_alert` naar de `custom_components`-map
   van je Home Assistant installatie.
2. Herstart Home Assistant.

Daarna in beide gevallen: ga naar **Instellingen > Apparaten & diensten >
Integratie toevoegen** en zoek naar "NL-Alert".

## Instellen

Bij het toevoegen vraagt de integratie alleen om je locatie en het
ophaalinterval. Al het andere staat in het **NL-Alert paneel** in de zijbalk:
speakers, alarmgeluid, stem, notificaties, nachtmodus, TV en de tests.

Klopt er iets niet, dan zegt het paneel precies wát — een verdwenen media
player, een ontbrekend geluidsbestand, een TTS-engine die niet gekozen is.

### Maandelijkse test

Wil je die aanzetten, dan is de **Holiday**-integratie van Home Assistant
vereist (land: Nederland). Zonder feestdagenkalender wordt de test elke maand
overgeslagen in plaats van geraden — een sirene op Koningsdag is erger dan een
gemiste test. Home Assistant meldt dit zelf via Reparaties.

## Entiteiten

| Entiteit | Beschrijving |
|---|---|
| `binary_sensor.nl_alert_alert_in_gebied` | Aan zodra een alert jouw gebied dekt |
| `sensor.nl_alert_actieve_alerts_nl` | Aantal actieve alerts in Nederland |
| `sensor.nl_alert_actieve_alerts_in_gebied` | Aantal in jouw gebied |
| `sensor.nl_alert_laatste_actieve_alert_nl` | Tekst van de laatste landelijke alert |
| `sensor.nl_alert_laatste_alert_in_gebied` | Tekst van de laatste alert bij jou |
| `button.nl_alert_test_*` | Vier testknoppen |

Er is ook een service `nl_alert.test_alert` en een Lovelace-kaart
`custom:nl-alert-card`.

## Beperkingen / aandachtspunten

- **Het paneel is alleen Nederlands.** De config flow is NL en EN; de
  paneelteksten nog niet.
- **Casten vereist HTTPS.** HA Cast werkt alleen als je instantie via HTTPS
  bereikbaar is (Nabu Casa Cloud of een eigen certificaat).
- **Kritieke notificaties zijn een verzoek, geen garantie.** Op iOS werkt het
  alleen met Apple's critical-alert-recht; op Android hangt het van het toestel
  af.
- **Kaartlagen veranderen.** CARTO zet sinds augustus 2026 "API KEY REQUIRED"
  in elke tegel en is daarmee onbruikbaar zonder sleutel. Standaard is nu
  OpenStreetMap; Esri staat als alternatief klaar en je kunt elke andere
  tegel-URL invullen.
- **Exacte timing.** De maandelijkse test vuurt op de seconde, maar tussen het
  commando en geluid uit een cloud-gekoppelde speaker zit latentie.

## Ontwikkelen

De pure logica — URL-opbouw, berichtsplitsing, geometrie, tijdvensters,
notificatie-payloads en de kalenderberekening — heeft offline checks die geen
draaiende Home Assistant nodig hebben:

```bash
python3 custom_components/nl_alert/tests/offline_checks.py
```

## Licentie

MIT — zie [LICENSE](LICENSE).
