# Asta Fantacalcio — App locale

App web per gestire l'asta del fantacalcio: dashboard su un PC comune, offerte dai telefoni dei partecipanti (stessa rete WiFi).

## 1. Requisiti

- [Node.js](https://nodejs.org) installato sul PC che farà da "regia" (quello con la dashboard). Versione 18+.

## 2. Installazione (una tantum)

Apri il terminale nella cartella del progetto ed esegui:

```
npm install
```

## 3. Avvio

```
npm start
```

Il terminale mostrerà qualcosa come:

```
✅ Server avviato! Apri sul PC: http://localhost:3000/admin.html
📱 Sui telefoni (stessa WiFi): http://<IP-DEL-PC>:3000/team.html
```

### Trovare l'IP del PC (da dare ai partecipanti)
- **Windows**: apri il prompt dei comandi, digita `ipconfig`, cerca "Indirizzo IPv4" (es. 192.168.1.15)
- **Mac**: Preferenze di Sistema → Rete, oppure `ifconfig | grep inet` nel terminale

Tutti i telefoni devono essere connessi alla **stessa rete WiFi** del PC. Su ogni telefono, aprire il browser e digitare:

```
http://192.168.1.15:3000/team.html
```

(sostituendo con l'IP reale del PC)

## 4. Come funziona l'asta (a chiamata libera per squadra)

Non è un'estrazione casuale: **ogni squadra, quando è il suo turno, sceglie liberamente quale giocatore mettere all'asta**, rispettando solo il ruolo del turno corrente e i propri slot ancora disponibili. La chiamata avviene in **due fasi**:

1. **Selezione pendente**: la squadra di turno chiama un giocatore, ma l'asta non parte ancora — solo lei può fare la prima offerta (minimo 1 credito). Questo le dà un attimo per cambiare idea prima di impegnarsi davvero: finché non offre, può richiamare un altro giocatore al suo posto.
2. **Asta vera**: appena la squadra chiamante fa la sua prima offerta, si apre a tutti — countdown configurabile (default 30s) che si resetta a ogni rilancio, come una normale asta al rialzo.

- Si parte dal primo ruolo dell'ordine impostato (es. Portieri): le squadre chiamano a turno, nell'ordine configurato, un portiere a testa
- Una squadra viene **saltata automaticamente** nel giro se ha già riempito tutti gli slot di quel ruolo
- Quando **tutte** le squadre hanno esaurito gli slot per quel ruolo (o non ci sono più giocatori disponibili), si passa in automatico al ruolo successivo, ripartendo dalla prima squadra dell'ordine
- Il turno passa alla squadra successiva automaticamente dopo ogni assegnazione (o se il giocatore resta invenduto)
- **L'asta non parte da sola**: dalla dashboard va avviata esplicitamente con il pulsante "Avvia asta" dopo aver completato il setup

## 5. Uso — sul PC (dashboard)

1. Apri `http://localhost:3000/admin.html`
2. **Setup**: carica il CSV giocatori (formato export Fantacalcio.it, **senza riga di intestazione**: colonna 1 = ID, colonna 2 = Nome, colonna 4 = Ruolo, colonna 10 = Squadra reale, colonna 16 = URL immagine card — la colonna usata per la Valutazione indicativa è configurabile in `server.js`, costante `COL.VALUTAZIONE`), imposta i nomi delle 8 squadre, l'**ordine di chiamata delle squadre** (trascina per riordinare) e l'ordine di chiamata dei ruoli
3. Clicca **"Avvia asta"** per iniziare — da quel momento il turno della prima squadra è attivo
4. Mentre una squadra sta scegliendo, la dashboard mostra in grande: nome squadra di turno, ruolo da scegliere, slot occupati/liberi per quel ruolo
5. Quando la squadra chiama un giocatore dal proprio telefono, la dashboard mostra la selezione in attesa della sua prima offerta; appena arriva, parte il countdown reale e tutti possono rilanciare
6. **"✓ Assegna ora"** chiude subito l'asta senza aspettare il countdown, assegnando a chi è in testa
7. **"⏭ Invenduto"** (visibile solo durante l'asta) annulla la chiamata corrente senza assegnare nessuno
8. **"⏭ Salta turno"** (visibile quando si aspetta una chiamata) fa passare il turno alla squadra successiva senza asta — utile se una squadra è assente o non risponde
9. **"🔧 Modifica rose"** nell'header permette di correggere manualmente qualsiasi assegnazione in caso di errori (assegna/svincola un giocatore a mano)
10. **Backup**: puoi salvare uno snapshot dello stato corrente (squadre, rose, crediti) in qualsiasi momento; i backup restano in `data/backups/` con marca temporale
11. **"Reset asta"** azzera completamente rose e crediti per ripartire da zero (usalo con cautela — non è reversibile)

## 6. Uso — sul telefono (partecipanti)

1. Apri il link `team.html` fornito
2. Scegli la propria squadra dal menu (una sola volta, resta salvata sul telefono)
3. **Quando tocca a te**: compare un banner "Tocca a te scegliere" con ruolo e slot disponibili; sotto trovi l'elenco dei giocatori disponibili per quel ruolo (filtrabile per squadra reale e cercabile per nome) — tocca un giocatore per metterlo all'asta
4. **Quando tocca a un'altra squadra**: compare "In attesa di chiamata da squadra X"; l'elenco dei giocatori disponibili resta visibile sotto, solo consultabile
5. **Durante un'asta**: pulsanti "+1 / +5 / +10" per rilanciare, oppure importo libero — se hai già riempito gli slot del ruolo in asta, l'intera area offerte si disattiva automaticamente
6. In basso: la propria rosa già composta, divisa per ruolo

## 7. Regole già gestite dal sistema

- Offerta minima: 1 credito
- Non puoi offrire più dei tuoi crediti disponibili
- Il sistema blocca offerte che lascerebbero meno di 1 credito per ogni slot di ruolo ancora da riempire
- Slot massimi/minimi per ruolo: personalizzabili dal setup (default 3 Portieri, 8 Difensori, 8 Centrocampisti, 6 Attaccanti)
- Crediti iniziali: 500 (modificabile in `server.js`, costante `STARTING_CREDITS`)
- Countdown: personalizzabile dal setup (default 10 secondi dall'ultima offerta)

## 8. Output

- In qualsiasi momento, dalla dashboard admin, clicca **"⬇ ESPORTA CSV"** per scaricare `fantacalcio_risultati.csv` con colonne: **Fantasquadra, id Calciatore, Prezzo** (l'id è quello originale del CSV di partenza, utile per fare il match con altri strumenti/import ufficiali)
- Il file viene anche salvato automaticamente in `data/output.csv` ad ogni assegnazione (backup in caso di imprevisti)
- La "Valutazione" (colonna 11) è mostrata solo come riferimento indicativo sulla card del giocatore — **tutte le aste partono comunque da 1 credito**, non influisce sulla logica

## 9. Note

- Se il PC va in stand-by o il server si riavvia, i dati di squadre/assegnazioni sono salvati in `data/state.json`, ma va reimportato il CSV giocatori se il processo Node viene chiuso (i giocatori NON assegnati sono ricalcolati dal CSV + dallo storico assegnazioni — se serve, chiedimi di aggiungere la ripresa automatica completa dello stato).
- Il file CSV di esempio `players_template.csv` è solo dimostrativo con pochi giocatori: sostituiscilo con la tua lista completa.
