// Configuración pública de Firebase (esto NO es un secreto: la seguridad la dan
// las reglas de Firestore y el inicio de sesión con Google).
// Si la pones en null, el tablero guarda los datos solo en este navegador.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyADhiRwPuYMLCubGVIrNDnPdQ4dUQZKj6Y",
  authDomain: "derek-b4d53.firebaseapp.com",
  projectId: "derek-b4d53",
  storageBucket: "derek-b4d53.firebasestorage.app",
  messagingSenderId: "764750726416",
  appId: "1:764750726416:web:5255ef999d3eee40f75195"
};

// ID de cliente OAuth para Google Calendar y Drive (público por diseño).
// Nunca pongas aquí el "client secret".
window.GOOGLE_CLIENT_ID = "764750726416-0sf524k69ilbm0n2cj8q3qr3najsp9a1.apps.googleusercontent.com";
