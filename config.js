/* ============================================================================
   TEEBUDDY — CONFIGURATION
   Ce fichier contient les données qui évoluent souvent : parcours et modes.
   Pour ajouter un parcours ou un mode, modifie uniquement ce fichier.
   (À terme, la page admin.html écrira ces données dans Firestore.)
============================================================================ */

/* ── Parcours de golf ───────────────────────────────────────────────────────
   pars      : tableau des 18 pars, du trou 1 au trou 18
   parTotal  : somme des pars (calculée mais notée pour affichage rapide)
---------------------------------------------------------------------------- */
window.COURSES = [
  {
    id: 'bassin-bleu',
    nom: 'Bassin Bleu',
    trous: 18,
    pars: [4, 3, 4, 4, 5, 3, 4, 4, 5, 3, 4, 3, 4, 5, 3, 4, 4, 5],
    parTotal: 72
  }
  // Pour ajouter un parcours, copie le bloc ci-dessus :
  // { id:'mon-golf', nom:'Mon Golf', trous:18, pars:[...18 valeurs...], parTotal: XX }
];

/* ── Modes de jeu ───────────────────────────────────────────────────────────
   teams : true si le mode se joue en équipes de 2
---------------------------------------------------------------------------- */
window.MODES = {
  stroke:    { label: 'Stroke Play',            teams: false, icon: '🏌️' },
  scramble:  { label: 'Scramble',               teams: true,  icon: '🤝' },
  mmb:       { label: 'Meilleure moins bonne',  teams: true,  icon: '⭐' },
  matchplay: { label: 'Match Play',             teams: false, icon: '⚔️', matchplay: true }
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
