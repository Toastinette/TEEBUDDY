/* ============================================================================
   TEEBUDDY — CONFIGURATION
   Ce fichier contient les données qui évoluent souvent : parcours et modes.
   Pour ajouter un parcours ou un mode, modifie uniquement ce fichier.
   (À terme, la page admin.html écrira ces données dans Firestore.)
============================================================================ */

/* ── Parcours de golf ───────────────────────────────────────────────────────
   pars      : tableau des 18 pars, du trou 1 au trou 18
   teeRatings: valeurs WHS par couleur de départ.
               Remplace les valeurs ci-dessous par les Course Rating et Slope
               officiels du parcours pour que les coups rendus varient par repère.
   parTotal  : somme des pars (calculée mais notée pour affichage rapide)
---------------------------------------------------------------------------- */
window.COURSES = [
  {
    id: 'bassin-bleu',
    nom: 'Bassin Bleu',
    trous: 18,
    pars: [4, 3, 4, 4, 5, 3, 4, 4, 5, 3, 4, 3, 4, 5, 3, 4, 4, 5],
    hcp:  [10, 6, 8, 4, 14, 16, 12, 17, 2, 5, 7, 13, 9, 11, 15, 1, 3, 18],
    teeRatings: {
      blanc: { slope: 133, courseRating: 71.5, par: 71 },
      jaune: { slope: 135, courseRating: 69.4, par: 71 },
      bleu:  { slope: 132, courseRating: 72.0, par: 71 },
      rouge: { slope: 120, courseRating: 69.7, par: 71 }
    },
    parTotal: 71,
    croixValue: 4
  }
  // Pour ajouter un parcours, copie le bloc ci-dessus :
  // { id:'mon-golf', nom:'Mon Golf', trous:18, pars:[...18 valeurs...], hcp:[...18 valeurs 1-18...],
  //   teeRatings:{ jaune:{ slope:113, courseRating:72.0, par:72 } }, parTotal: XX, croixValue: 4 }
];

/* ── Modes de jeu ───────────────────────────────────────────────────────────
   teams : true si le mode se joue en équipes de 2
---------------------------------------------------------------------------- */
window.MODES = {
  stroke:     { label: 'Stroke Play',            teams: false, icon: '🏌️' },
  stableford: { label: 'Stableford',             teams: false, icon: '🎯', stableford: true },
  syndicat:   { label: 'Syndicat',               teams: false, icon: '💶', syndicat: true },
  scramble:   { label: 'Scramble',               teams: true,  icon: '🤝' },
  mmb:        { label: 'Meilleure moins bonne',  teams: true,  icon: '⭐' },
  matchplay:  { label: 'Match Play',             teams: false, icon: '⚔️', matchplay: true }
};

/* ── Configuration Firebase ─────────────────────────────────────────────────
   Si tu changes de projet Firebase, modifie uniquement ce bloc.
---------------------------------------------------------------------------- */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyDl6TojOx07QV6R8lxRkq2LebMcM3og720",
  authDomain: "teebuddy-f4df9.firebaseapp.com",
  projectId: "teebuddy-f4df9",
  storageBucket: "teebuddy-f4df9.firebasestorage.app",
  messagingSenderId: "235732896235",
  appId: "1:235732896235:web:3767c93dcd4280398031ae"
};
