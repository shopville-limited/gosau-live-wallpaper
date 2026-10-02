// Nastavení scény „Krkonoše – Sněžka“: výhled ze Studniční hory, den a noc, roční období.
// Po úpravě stačí v menu tapety zvolit „Znovu načíst scénu“, v náhledu obnovit stránku.
// Délky ve světě jsou v kilometrech, na obrazovce v bodech, časy v sekundách.

export default {
  // Semínko náhody: jiné číslo = jinak tvarované hory, mraky a vlnky.
  // Každý monitor k němu přičte své pořadí, takže má každý trochu jiné pohoří.
  seed: 1938,

  // Strop snímků za sekundu. Ptáci, les ve větru a vlnky potřebují 60, aby se hýbaly plynule.
  // Na baterii a u zakryté plochy tapeta zpomalí sama.
  fps: 30,
  fpsNaBaterii: 20,

  // Kvalita krajiny: kolik paprsků se počítá na jeden pixel (1–4). Víc = hladší hrany
  // hřebenů a sněhu, ale krajina se po startu dopočítává déle.
  kvalita: 4,

  // Rozlišení vykreslování (0,25–1): 1 = plné, 0,5 = poloviční (4× méně práce pro grafiku).
  // Když prohlížeč kreslí bez grafické karty, použije se 0,5 automaticky.
  rozliseni: 1,
  // Nejvýš tolik milionů pixelů na obrazovku (3440 × 1440 je 5; 2,5 = asi poloviční práce).
  // Víc zatěžuje grafickou kartu, méně rozmaže detail.
  megapixely: 2.5,

  // Na které straně plochy máte ikony: 'vlevo' nebo 'vpravo'.
  // Hlavní masiv s ledovcem je na opačné straně.
  ikony: 'vlevo',

  // Den a noc, roční období.
  cas: {
    // 'skutecny' = slunce podle hodin počítače, 'pevny' = pořád stejná hodina (viz hodina).
    rezim: 'skutecny',
    hodina: 18.5,
    // Měsíc v roce: 'skutecny' = podle kalendáře, nebo číslo 1–12 (1 = leden).
    // Mění sněžnou čáru, barvy lesa, zamrzlé jezero a dráhu slunce.
    mesic: 'skutecny',
    // Místo, pro které se počítá poloha slunce a počasí (Studniční hora).
    sirka: 50.7286,
    delka: 15.7117,
    // Akce „Přehrát den“: celý den za tolik sekund.
    prehratDenZa: 120,
  },

  // Stíny hor podle polohy slunce (v noci měsíce). Přepočítávají se průběžně.
  stiny: true,

  // Expozice a kontrast tónové křivky. Noc se automaticky zesvětlí, aby bylo co vidět.
  jas: 1.0,
  kontrast: 1.1,

  // Kde je na obrazovce obzor (0 = dole, 1 = nahoře) a zorný úhel kamery (stupně na výšku).
  obzor: 0.62,
  zornyUhel: 30,

  // Počasí: 'skutecne' = oblačnost, vítr, sněžení a mlha podle skutečného počasí na Sněžce
  // (Open-Meteo, stahuje se jednou za 15 minut; posílají se jen souřadnice z cas.sirka
  // a cas.delka). Bez sítě, při pevné hodině nebo jiném měsíci se použije vymyšlené
  // počasí podle ročního období. 'vymyslene' = nikdy nic nestahovat.
  pocasi: 'skutecne',

  // Vymyšlené mraky: kolik oblohy zakrývají (0–1, k tomu se přičte roční období) a jak rychle plují.
  mraky: { pokryti: 0.45, rychlost: 1.0 },

  // Mlha v údolí (0 = žádná, 1 = hustá). Na podzim a za svítání je jí víc.
  mlha: 0.5,

  // Sněžení v zimě: jakou část času sněží (0 = nikdy, 1 = pořád).
  snezeni: 0.35,

  // Jezero: jak moc je hladina zčeřená (0 = dokonalé zrcadlo).
  jezero: { vlnky: 0.35 },

  // Loďky na jezeře: kolik jich pluje. Plätte je tradiční dřevěná loď ze Solné komory
  // (rybář občas zastaví a chytá, večer na ní svítí lucerna). Kánoe a kajak jezdí jen ve dne.
  lodky: { platte: 0, kanoe: 0, kajak: 0, labute: 0, kachny: 0, bruslari: 0 },


  // Na kurzor reagují jen ptáci, krajina a voda zůstávají v klidu.
  // Hejno ptáků (jen ve dne): průměrně jednou za tolik sekund, kolik ptáků a jak se bojí kurzoru.
  ptaci: { kazdych: 30, prvni: 6, pocet: 22, plachost: 150 },

  // Poryv větru: průměrně jednou za tolik sekund.
  vitr: { kazdych: 80 },
};
