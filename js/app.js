/*
  Natter AI app code. Moved out of index.html so the page is
  easier to work on. It is one classic script on purpose: it
  runs after the page markup, exactly as it did inline.
*/


/* =====================================================
   CONFIG
===================================================== */

const SUPABASE_URL =
  'https://fzwqunpnohgwgwikumkt.supabase.co';

const SUPABASE_KEY =
  'sb_publishable_kNUxEr43Kp5qVC4Evxgz0A_iCTLw7GB';

const API_BASE =
  'https://ai-8vlt.onrender.com';

/*
  Where the app itself lives. Auth emails come back
  here, NOT to the API.
*/
const LIVE_SITE_URL =
  'https://nastivee.github.io/Ai/';


/* =====================================================
   SUPABASE
===================================================== */

const supabaseClient =
  window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_KEY
  );


/* =====================================================
   STATE
===================================================== */

let currentUser = null;
let currentChatId = null;

let chats = [];

let memory = '';

/* Set when saved memory is under a key this device cannot open */
let memoryLocked = false;

let selectedImageFile = null;
let selectedImageData = null;

let imageMode = false;

/* what to do with an attached photo: 'edit' or 'ask' */
let photoAction = 'edit';

/* true once the user taps Edit it or Ask about it themselves */
let photoActionChosen = false;

/*
  When nobody has picked, the words decide. A question about
  the photo ("what does it say on the can?") is answered in
  words, and the photo is never redrawn. Anything that asks
  for a change is an edit.
*/
function guessPhotoAction(text) {

  const t = String(text || '').trim().toLowerCase();

  if (!t) return 'edit';

  const editWords =
    /\b(make|turn|change|replace|remove|erase|add|put|edit|convert|recolou?r|colou?r in|restyle|style it|swap|brighten|darken|blur|crop|fix|retouch|enhance|upscale|cartoon|anime|draw|redraw|paint|give (it|him|her|them)|in the style of|background)\b/;

  const askWords =
    /^(what|what's|whats|who|who's|where|when|why|how|which|is|are|was|were|does|do|did|can you (read|tell|see|describe|explain|identify|translate)|could you (read|tell|describe|explain)|read|tell me|describe|explain|identify|translate|transcribe|count|name)\b|\b(what does it say|what it says|what is (this|that|it)|what's written|the (text|writing|wording|words|label|brand)|read (it|this|the))\b/;

  if (askWords.test(t) && !/^(make|turn|change|replace|remove|add|put|edit)\b/.test(t)) {
    return 'ask';
  }

  if (/\?\s*$/.test(t) && !editWords.test(t)) {
    return 'ask';
  }

  return 'edit';

}

/* the shape of the next generated image */
let imageShape = 'square';

/* Create video, admins only while it is tested */
let videoMode = false;

/* lets the user stop a reply part way through */
let replyController = null;

/* 'fast' for everyday, 'smart' for harder questions */
let chatMode =
  (() => {
    try {
      return localStorage.getItem('nastivee_mode') || 'fast';
    } catch {
      return 'fast';
    }
  })();

let initialised = false;
let imageBusy = false;

let loadSequence = 0;
let activeRequestId = 0;
let imageRequestId = 0;


/*
  Stores the image history currently displayed.

  Each image message has:

  {
    currentImage,
    originalImage,
    prompt
  }

  For re-rendering, currentImage is always used.
*/

const imageState = new Map();

/* Keeps Improve from repeating the same steer twice in a row */
let improveSequence = 0;


/* =====================================================
   GUEST MODE

   Guest chats live in this browser only. Nothing is
   sent to Supabase and nothing follows the user to
   another device.
===================================================== */

let guestMode = false;

const GUEST_FLAG_KEY = 'nastivee_guest_mode';
const GUEST_CHATS_KEY = 'nastivee_guest_chats';
const GUEST_MEMORY_KEY = 'nastivee_guest_memory';

function guestMessagesKey(chatId) {
  return `nastivee_guest_messages_${chatId}`;
}

function readLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function guestChats() {
  return readLocal(GUEST_CHATS_KEY, []);
}

function saveGuestChats(list) {
  writeLocal(GUEST_CHATS_KEY, list);
}

function guestMessages(chatId) {
  return readLocal(guestMessagesKey(chatId), []);
}

/*
  Images are stored as data URLs and browser storage
  is small, so when it fills up we drop the oldest
  images in this chat rather than losing the chat.
*/
function saveGuestMessages(chatId, list) {

  if (writeLocal(guestMessagesKey(chatId), list)) {
    return true;
  }

  const trimmed = list.map(item => ({ ...item }));

  for (const item of trimmed) {

    if (item.image_url) {

      item.image_url = null;
      item.image_dropped = true;

      if (writeLocal(guestMessagesKey(chatId), trimmed)) {
        return true;
      }

    }

  }

  return writeLocal(
    guestMessagesKey(chatId),
    trimmed.slice(-30)
  );

}


/* =====================================================
   RUNNING JOBS

   Several replies and images can run at once, in any
   chat. Each job remembers the chat it belongs to, so
   the user can switch chats while it finishes.
===================================================== */

const jobs = new Map();

let jobSequence = 0;

function startJob(chatId, label) {

  const id = ++jobSequence;

  jobs.set(id, { chatId, label });

  refreshJobUI();

  watchForSlowStart(label);

  return id;

}

function endJob(id) {

  jobs.delete(id);

  if (!jobs.size) {
    stopWatchingSlowStart();
  }

  refreshJobUI();

}

function jobsForChat(chatId) {

  return [...jobs.values()].filter(
    job => String(job.chatId) === String(chatId)
  );

}

/*
  The server sleeps when it is not being used, and waking
  it takes the best part of a minute. Say so, rather than
  leaving the user watching a silent spinner.
*/

let wakeTimer = null;

function watchForSlowStart(label) {

  clearTimeout(wakeTimer);

  wakeTimer = setTimeout(() => {

    const running =
      jobsForChat(currentChatId);

    if (running.length) {

      progressText.textContent =
        'Waking the server, this can take up to a minute...';

    }

  }, 6000);

}

function stopWatchingSlowStart() {

  clearTimeout(wakeTimer);

}


function refreshJobUI() {

  const mine = jobsForChat(currentChatId);

  if (mine.length) {

    progressText.textContent =
      mine.length === 1
        ? mine[0].label
        : `${mine[0].label} (${mine.length} running in this chat)`;

    imageProgress.classList.add('show');

  } else {

    imageProgress.classList.remove('show');

  }

  renderChatHistory();

}

function isCurrentChat(chatId) {
  return String(chatId) === String(currentChatId);
}

function nudgeRepaint(element) {

  if (!element) return;

  element.style.transform = 'translateZ(0)';

  // reading a layout value forces the browser to catch up
  void element.offsetHeight;

  requestAnimationFrame(() => {
    element.style.transform = '';
  });

}


/* =====================================================
   DOM
===================================================== */

const authScreen =
  document.getElementById('authScreen');

const app =
  document.getElementById('app');

const authEmail =
  document.getElementById('authEmail');

const authPassword =
  document.getElementById('authPassword');

const authButton =
  document.getElementById('authButton');

const authError =
  document.getElementById('authError');

const authSwitchButton =
  document.getElementById('authSwitchButton');

const authSwitchText =
  document.getElementById('authSwitchText');

const userEmail =
  document.getElementById('userEmail');

const chat =
  document.getElementById('chat');

let emptyState =
  document.getElementById('emptyState');

const messageInput =
  document.getElementById('messageInput');

const sendButton =
  document.getElementById('sendButton');

const imageButton =
  document.getElementById('imageButton');

const uploadButton =
  document.getElementById('uploadButton');

const fileInput =
  document.getElementById('fileInput');

const uploadPreview =
  document.getElementById('uploadPreview');

const uploadThumbs =
  document.getElementById('uploadThumbs');

/* every photo waiting to be sent, newest last, up to four */
let selectedImages = [];

/*
  Draws the little row of photos waiting to go, each with
  its own X. selectedImageData stays as the first one, so
  everything that only ever handled a single photo keeps
  working.
*/
function paintUploads() {

  selectedImageData = selectedImages[0]?.data || null;

  if (!uploadThumbs) return;

  uploadThumbs.innerHTML = '';

  selectedImages.forEach((item, index) => {

    const slot = document.createElement('div');
    slot.className = 'uploadThumbSlot';

    const img = document.createElement('img');
    img.className = 'uploadThumb';
    img.alt = item.name || `Photo ${index + 1}`;
    img.src = item.data;
    slot.appendChild(img);

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'uploadThumbDrop';
    drop.title = 'Take this photo off';
    drop.setAttribute('aria-label', 'Take this photo off');
    drop.textContent = '\u00d7';

    drop.addEventListener('click', event => {
      event.stopPropagation();
      selectedImages.splice(index, 1);
      if (!selectedImages.length) {
        clearUpload();
      } else {
        paintUploads();
      }
    });

    slot.appendChild(drop);
    uploadThumbs.appendChild(slot);

  });

  if (uploadName) {
    uploadName.textContent =
      selectedImages.length > 1
        ? `${selectedImages.length} photos`
        : (selectedImages[0]?.name || '');
  }

  uploadPreview.classList.toggle('show', selectedImages.length > 0);

}

const uploadName =
  document.getElementById('uploadName');

const chatMenuButton =
  document.getElementById('chatMenuButton');

const chatMenu =
  document.getElementById('chatMenu');

const jumpButton =
  document.getElementById('jumpButton');

const stopButton =
  document.getElementById('stopButton');

const shapeRow =
  document.getElementById('shapeRow');

const photoChoice =
  document.getElementById('photoChoice');

const clearUploadButton =
  document.getElementById('clearUploadButton');

const newChatButton =
  document.getElementById('newChatButton');

const versionTag =
  document.getElementById('versionTag');

const modeSwitch =
  document.getElementById('modeSwitch');

const headerStatus =
  document.getElementById('headerStatus');

const chatSearch =
  document.getElementById('chatSearch');

const chatSearchWrap =
  document.getElementById('chatSearchWrap');

const searchToggle =
  document.getElementById('searchToggle');

const chatHistoryList =
  document.getElementById('chatHistoryList');

const onlineCountLabel =
  document.getElementById('onlineCount');

const statusDot =
  document.getElementById('statusDot');

const guestButton =
  document.getElementById('guestButton');

const guestNotice =
  document.getElementById('guestNotice');

const guestSignUpButton =
  document.getElementById('guestSignUpButton');

const logoutButton =
  document.getElementById('logoutButton');

const headerTitle =
  document.getElementById('headerTitle');

const profileButton =
  document.getElementById('profileButton');

const profileOverlay =
  document.getElementById('profileOverlay');

const profileClose =
  document.getElementById('profileClose');

const profileSave =
  document.getElementById('profileSave');

const profileEmail =
  document.getElementById('profileEmail');

const profileHint =
  document.getElementById('profileHint');

const memoryTextarea =
  document.getElementById('memoryTextarea');

const imageProgress =
  document.getElementById('imageProgress');

const progressText =
  document.getElementById('progressText');

const sidebar =
  document.getElementById('sidebar');

const sidebarOverlay =
  document.getElementById('sidebarOverlay');

const mobileMenuButton =
  document.getElementById('mobileMenuButton');


/* =====================================================
   MOBILE SIDEBAR
===================================================== */

function openMobileSidebar() {

  sidebar.classList.add('mobileOpen');

  sidebarOverlay.classList.add('show');

}

function closeMobileSidebar() {

  sidebar.classList.remove('mobileOpen');

  sidebarOverlay.classList.remove('show');

}

mobileMenuButton.addEventListener(
  'click',
  openMobileSidebar
);

sidebarOverlay.addEventListener(
  'click',
  closeMobileSidebar
);


/* =====================================================
   PASSWORD VIEW / HIDE
===================================================== */

function wirePasswordToggle(toggleId, inputId) {

  const toggle =
    document.getElementById(toggleId);

  const input =
    document.getElementById(inputId);

  if (!toggle || !input) return;

  toggle.addEventListener(
    'click',
    () => {

      const showing =
        input.type === 'text';

      input.type =
        showing
          ? 'password'
          : 'text';

      toggle.textContent =
        showing
          ? 'Show'
          : 'Hide';

      const label =
        showing
          ? 'Show password'
          : 'Hide password';

      toggle.setAttribute('aria-label', label);
      toggle.title = label;

      input.focus();

    }
  );

}

wirePasswordToggle('passwordToggle', 'authPassword');
wirePasswordToggle('resetPasswordToggle', 'resetPassword');
wirePasswordToggle('resetPasswordConfirmToggle', 'resetPasswordConfirm');


/* =====================================================
   SET A NEW PASSWORD

   The reset email brings the user back with a recovery
   session. We hold the app back and ask for the new
   password first.
===================================================== */

let recoveryMode = false;

const resetScreen =
  document.getElementById('resetScreen');

const resetPassword =
  document.getElementById('resetPassword');

const resetPasswordConfirm =
  document.getElementById('resetPasswordConfirm');

const resetSaveButton =
  document.getElementById('resetSaveButton');

const resetError =
  document.getElementById('resetError');

const resetCancelButton =
  document.getElementById('resetCancelButton');


function isRecoveryLink() {

  const hash =
    window.location.hash || '';

  const search =
    window.location.search || '';

  return (
    hash.includes('type=recovery') ||
    search.includes('type=recovery')
  );

}


function showResetScreen() {

  recoveryMode = true;

  resetError.textContent = '';

  resetScreen.classList.add('show');

  authScreen.style.display = 'none';

  app.classList.remove('visible');

  resetPassword.focus();

}


function hideResetScreen() {

  recoveryMode = false;

  resetScreen.classList.remove('show');

}


async function saveNewPassword() {

  const password =
    resetPassword.value;

  const confirmation =
    resetPasswordConfirm.value;

  resetError.style.color = '#ff8585';

  if (!password || password.length < 6) {

    resetError.textContent =
      'Your new password must be at least 6 characters.';

    return;
  }

  if (password !== confirmation) {

    resetError.textContent =
      'The two passwords do not match.';

    return;
  }

  resetSaveButton.disabled = true;

  resetError.textContent = '';

  try {

    const { error } =
      await supabaseClient.auth.updateUser({
        password
      });

    if (error) throw error;

    /*
      If this device still holds the key, move the lock onto
      the new password now and nothing is lost. If it does
      not, the new password is handed to the unlock step,
      which asks for a recovery code or the old password.
    */
    if (currentUser && (dataKey || (await recallDataKey()))) {

      try {
        await relockWithPassword(password);
      } catch (relockError) {
        console.error('RELOCK AFTER RESET FAILED:', relockError);
      }

    } else {

      pendingPassword = password;

    }

    resetError.style.color = '#9ee6bd';

    resetError.textContent =
      'Password updated. Opening your account...';

    resetPassword.value = '';
    resetPasswordConfirm.value = '';

    /*
      Clear the recovery link out of the address bar
      so a refresh does not reopen this screen.
    */

    if (window.history?.replaceState) {

      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search
      );

    }

    setTimeout(
      async () => {

        hideResetScreen();

        const { data } =
          await supabaseClient.auth.getSession();

        if (data?.session?.user) {

          currentUser = data.session.user;

          await initialiseApp();

        } else {

          showAuth();

        }

      },
      900
    );

  } catch (error) {

    resetError.style.color = '#ff8585';

    resetError.textContent =
      error?.message ||
      'Could not update your password.';

  } finally {

    resetSaveButton.disabled = false;

  }

}


resetSaveButton.addEventListener(
  'click',
  saveNewPassword
);

resetPasswordConfirm.addEventListener(
  'keydown',
  event => {

    if (event.key === 'Enter') {
      event.preventDefault();
      saveNewPassword();
    }

  }
);

resetCancelButton.addEventListener(
  'click',
  async () => {

    hideResetScreen();

    await supabaseClient.auth.signOut();

    showAuth();

  }
);


/* =====================================================
   FORGOTTEN PASSWORD
===================================================== */

const authForgotButton =
  document.getElementById('authForgotButton');

authForgotButton.addEventListener(
  'click',
  async () => {

    const email =
      authEmail.value.trim();

    if (!email) {

      authError.style.color = '#ff8585';

      authError.textContent =
        'Enter your email address first, then tap Forgotten your password.';

      authEmail.focus();

      return;
    }

    authForgotButton.disabled = true;

    authError.style.color = '#ff8585';
    authError.textContent = '';

    try {

      const { error } =
        await supabaseClient.auth.resetPasswordForEmail(
          email,
          {
            redirectTo: LIVE_SITE_URL
          }
        );

      if (error) throw error;

      authError.style.color = '#8ee6a1';

      authError.textContent =
        'Password reset email sent. Check your inbox.';

    } catch (error) {

      authError.style.color = '#ff8585';

      authError.textContent =
        error?.message ||
        'Could not send the reset email.';

    } finally {

      authForgotButton.disabled = false;

    }

  }
);


/* =====================================================
   AUTH MODE
===================================================== */

let signupMode = false;

function updateAuthMode() {

  document
    .getElementById('authScreen')
    ?.classList.toggle('signup', signupMode);

  const subtitle =
    document.getElementById('authSubtitle');

  if (subtitle) {

    subtitle.dataset.login =
      subtitle.dataset.login || subtitle.textContent.trim();

    subtitle.textContent =
      signupMode
        ? 'Create your account'
        : subtitle.dataset.login;

  }

  if (signupMode) {

    authButton.textContent =
      'Create account';

    authSwitchText.textContent =
      'Already have an account?';

    authSwitchButton.textContent =
      'Log in';

  } else {

    authButton.textContent =
      'Log in';

    authSwitchText.textContent =
      "Don't have an account?";

    authSwitchButton.textContent =
      'Sign up';

  }

  authError.textContent = '';

}

/* the whole pill works, not just the words in it */
document.querySelector('.authSwitch')?.addEventListener('click', event => {
  if (!event.target.closest('#authSwitchButton')) authSwitchButton.click();
});

authSwitchButton.addEventListener(
  'click',
  () => {

    signupMode = !signupMode;

    updateAuthMode();

    /* the same sweep as Fast and Smart: into sign up (Smart's
       blue) left to right, back to log in (Fast's purple)
       right to left */
    shineAcross(signupMode ? 'smart' : 'fast');

  }
);


/* =====================================================
   AUTH
===================================================== */

authButton.addEventListener(
  'click',
  handleAuth
);

authPassword.addEventListener(
  'keydown',
  event => {

    if (event.key === 'Enter') {
      handleAuth();
    }

  }
);

authEmail.addEventListener(
  'keydown',
  event => {

    if (event.key === 'Enter') {
      authPassword.focus();
    }

  }
);


async function handleAuth() {

  const email =
    authEmail.value.trim();

  const password =
    authPassword.value;


  if (!email || !password) {

    authError.textContent =
      'Enter your email and password.';

    return;

  }


  authButton.disabled = true;

  authError.textContent = '';


  try {

    if (signupMode) {

      pendingPassword = password;

      const {
        data,
        error
      } =
        await supabaseClient.auth.signUp({

          email,
          password,

          options: {
            emailRedirectTo:
              LIVE_SITE_URL
          }

        });


      if (error) {

        pendingPassword = null;

        throw error;

      }

      if (data?.user && !data.session) {

        authError.style.color =
          '#9ee6bd';

        authError.textContent =
          'Account created. Check your email to confirm your account.';

      } else {

        authError.style.color =
          '#9ee6bd';

        authError.textContent =
          'Account created successfully.';

      }

    } else {

      /*
        Supabase can fire its auth event before this call
        returns, and the vault is opened on that event, so
        the password has to be waiting before we ask.
      */
      pendingPassword = password;

      const {
        error
      } =
        await supabaseClient.auth.signInWithPassword({

          email,
          password

        });


      if (error) {

        pendingPassword = null;

        throw error;

      }

    }

  } catch (error) {

    authError.style.color =
      '#ff8585';

    authError.textContent =
      error?.message ||
      'Authentication failed.';

  } finally {

    authButton.disabled = false;

  }

}


/* =====================================================
   AUTH STATE
===================================================== */

supabaseClient.auth.onAuthStateChange(
  async (_event, session) => {

    if (_event === 'PASSWORD_RECOVERY') {

      currentUser =
        session?.user || null;

      showResetScreen();

      return;

    }

    if (recoveryMode) {
      return;
    }

    if (session?.user) {

      if (guestMode) {
        stopGuestMode();
      }

      currentUser =
        session.user;

      try {

        await initialiseApp();

      } catch (error) {

        /*
          Never leave somebody staring at the log in screen
          with no idea why. Say what happened.
        */
        console.error('START UP FAILED:', error);

        authError.style.color = '#ff8585';

        authError.textContent =
          'Signed in, but the app could not start: ' +
          (error?.message || 'unknown error') +
          '. Try again, or tell us what this says.';

      }

    } else if (!guestMode) {

      currentUser = null;

      showAuth();

    }

  }
);


function startGuestMode() {

  guestMode = true;

  currentUser = null;

  currentChatId = null;

  try {
    localStorage.setItem(GUEST_FLAG_KEY, '1');
  } catch {}

  initialiseApp();

}


function stopGuestMode() {

  guestMode = false;

  chats = [];

  currentChatId = null;

  jobs.clear();

  try {
    localStorage.removeItem(GUEST_FLAG_KEY);
  } catch {}

}


guestButton.addEventListener(
  'click',
  startGuestMode
);


guestSignUpButton.addEventListener(
  'click',
  () => {

    stopGuestMode();

    signupMode = true;

    updateAuthMode();

    showAuth();

  }
);


/* =====================================================
   WAITING FOR THE PAGE

   A count, not a flag, because opening an account starts
   inside starting the page, and the overlay should only go
   when the outermost wait is over.
===================================================== */

let bootDepth = 0;

let bootSlowTimer = null;
let bootStuckTimer = null;


function showBoot(message) {

  const overlay =
    document.getElementById('bootOverlay');

  if (!overlay) return;

  bootDepth += 1;

  document.getElementById('bootText').textContent =
    message || 'Loading';

  document.getElementById('bootSkip').classList.remove('show');

  overlay.classList.remove('leaving');
  overlay.classList.add('show');

  clearTimeout(bootSlowTimer);
  clearTimeout(bootStuckTimer);

  /* the free server sleeps, so a long first wait is normal */
  bootSlowTimer = setTimeout(() => {
    document.getElementById('bootText').textContent =
      'Waking the server, this can take up to a minute...';
  }, 4000);

  /* never trap anyone behind it */
  bootStuckTimer = setTimeout(() => {
    document.getElementById('bootText').textContent =
      'This is taking longer than usual.';
    document.getElementById('bootSkip').classList.add('show');
  }, 20000);

}


function hideBoot(force) {

  const overlay =
    document.getElementById('bootOverlay');

  if (!overlay) return;

  bootDepth = force ? 0 : Math.max(0, bootDepth - 1);

  if (bootDepth > 0) return;

  clearTimeout(bootSlowTimer);
  clearTimeout(bootStuckTimer);

  if (!overlay.classList.contains('show')) return;

  overlay.classList.add('leaving');
  overlay.classList.remove('show');

  setTimeout(() => {
    overlay.classList.remove('leaving');
  }, 260);

}

document
  .getElementById('bootSkip')
  ?.addEventListener('click', () => hideBoot(true));


async function checkSession() {

  /*
    The overlay is already showing from the markup, so this
    claims it rather than showing it again.
  */
  bootDepth += 1;

  try {

    return await checkSessionInner();

  } finally {

    hideBoot();

  }

}


async function checkSessionInner() {

  // the count is live on the login screen as well
  startPresence();

  const {
    data
  } =
    await supabaseClient.auth.getSession();

  if (data?.session?.user && isRecoveryLink()) {

    currentUser =
      data.session.user;

    showResetScreen();

    return;

  }

  if (data?.session?.user) {

    currentUser =
      data.session.user;

    await initialiseApp();

    return;

  }


  let wasGuest = false;

  try {
    wasGuest = localStorage.getItem(GUEST_FLAG_KEY) === '1';
  } catch {}


  if (wasGuest) {

    startGuestMode();

    return;

  }


  showAuth();

}


function showAuth() {

  authScreen.style.display =
    'flex';

  app.classList.remove(
    'visible'
  );

}


function showApp() {

  authScreen.style.display =
    'none';

  app.classList.add(
    'visible'
  );

}


/* =====================================================
   INITIALISE
===================================================== */

async function initialiseApp() {

  showBoot('Opening your chats');

  try {

    return await initialiseAppInner();

  } finally {

    hideBoot();

  }

}


async function initialiseAppInner() {

  if (!currentUser && !guestMode) {
    return;
  }

  /*
    While the site is being prepared, only admins get past
    here. The server is the one that decides, the screen
    is just what the rest of the world sees.
  */
  try {

    if (guestMode) {

      if (await siteIsHolding()) {
        showHolding();
        return;
      }

    } else {

      await refreshAccount();

      if (account.holding === true && account.admin !== true) {
        showHolding();
        return;
      }

    }

  } catch (error) {

    console.error('HOLDING CHECK FAILED:', error);

  }

  if (!guestMode && !(await unlockVault())) {
    return;
  }

  showApp();

  /*
    The email lives in My profile now, not the sidebar.
  */
  if (userEmail) {

    userEmail.textContent =
      guestMode
        ? 'Guest'
        : (currentUser?.email || '');

  }

  guestNotice.classList.toggle('show', guestMode);

  startPresence();

  memory =
    await loadMemory();

  memoryTextarea.value =
    memory || '';

  await loadChats();

  loadSavedComments().catch(error => console.error('SAVED LOAD ERROR:', error));

  if (!currentChatId) {

    newChat();

  }

  initialised = true;

  refreshAccount();

  checkPaymentReturn();

  /* in the background, never in the way */
  setTimeout(encryptLegacy, 1500);

}


/* =====================================================
   MEMORY
===================================================== */

/* =====================================================
   MY PROFILE
===================================================== */

function openProfile() {

  profileEmail.textContent =
    guestMode
      ? 'Guest, on this device only'
      : (currentUser?.email || '');

  profileHint.textContent =
    guestMode
      ? 'Saved in this browser and used in every chat.'
      : 'Saved to your account and used in every chat.';

  memoryTextarea.value =
    memory || '';

  profileOverlay.classList.add('show');

  paintSecurity();

  closeMobileSidebar();

}


function closeProfile() {

  profileOverlay.classList.remove('show');

}


profileButton.addEventListener(
  'click',
  openProfile
);

profileClose.addEventListener(
  'click',
  closeProfile
);

/* tapping the dimmed area closes it, tapping the card does not */
profileOverlay.addEventListener(
  'click',
  event => {

    if (event.target === profileOverlay) {
      closeProfile();
    }

  }
);

document.addEventListener(
  'keydown',
  event => {

    if (
      event.key === 'Escape' &&
      profileOverlay.classList.contains('show')
    ) {
      closeProfile();
    }

  }
);


profileSave.addEventListener(
  'click',
  async () => {

    profileSave.disabled = true;

    profileSave.textContent = 'Saving...';

    await saveMemory();

    profileSave.textContent = 'Saved';

    setTimeout(() => {

      profileSave.disabled = false;

      profileSave.textContent = 'Save';

      closeProfile();

    }, 700);

  }
);


memoryTextarea.addEventListener(
  'blur',
  saveMemory
);


async function loadMemory() {

  if (guestMode) {
    return readLocal(GUEST_MEMORY_KEY, '') || '';
  }


  if (!currentUser) {
    return '';
  }


  try {

    const {
      data,
      error
    } =
      await supabaseClient
        .from('profiles')
        .select('memory')
        .eq(
          'id',
          currentUser.id
        )
        .maybeSingle();


    if (error) {

      console.error(
        'MEMORY LOAD ERROR:',
        error
      );

      return '';

    }


    const opened =
      await decFieldResult(data?.memory || '');

    memoryLocked = opened.locked;

    /* never hand the placeholder to the AI as if it were memory */
    if (opened.locked) return '';

    if (opened.stale && opened.text) {
      supabaseClient
        .from('profiles')
        .update({ memory: await encField(opened.text) })
        .eq('id', currentUser.id)
        .then(() => {}, () => {});
    }

    return opened.text;

  } catch (error) {

    console.error(
      'MEMORY LOAD EXCEPTION:',
      error
    );

    return '';

  }

}


/*
  Writes to the user's own profile row. An upsert asks
  the database for permission to rewrite the id column as
  well, which the column grants rightly refuse, so it is
  an update first and an insert only when there is no row.
*/
async function saveProfile(fields) {

  const { data, error } =
    await supabaseClient
      .from('profiles')
      .update(fields)
      .eq('id', currentUser.id)
      .select('id');

  if (error) return { error };

  if (data?.length) return { error: null };

  const { error: insertError } =
    await supabaseClient
      .from('profiles')
      .insert({ id: currentUser.id, ...fields });

  return { error: insertError || null };

}


async function saveMemory() {

  if (!currentUser && !guestMode) {
    return false;
  }


  memory =
    memoryTextarea.value.trim();


  if (guestMode) {
    writeLocal(GUEST_MEMORY_KEY, memory);
    return true;
  }

  /* do not wipe memory we simply could not open here */
  if (memoryLocked && !memory) {
    return false;
  }

  memoryLocked = false;


  try {

    const { error } =
      await saveProfile({ memory: await encField(memory) });

    if (error) {

      console.error('MEMORY SAVE ERROR:', error);

      return false;

    }

    return true;

  } catch (error) {

    console.error('MEMORY SAVE EXCEPTION:', error);

    return false;

  }

}


/* =====================================================
   CHAT LIST
===================================================== */

async function loadChats() {

  if (guestMode) {

    chats = guestChats();

    renderChatHistory();

    return true;

  }


  if (!currentUser) {
    return false;
  }


  try {

    const {
      data,
      error
    } =
      await supabaseClient
        .from('chats')
        .select('*')
        .eq(
          'user_id',
          currentUser.id
        )
        .order(
          'created_at',
          {
            ascending: false
          }
        );


    if (error) {
      throw error;
    }


    chats =
      await decRows(data, ['title']);

    resealStale('chats', chats, ['title']);

    renderChatHistory();

    return true;


  } catch (error) {

    console.error(
      'CHAT LOAD ERROR:',
      error
    );

    return false;

  }

}


function renderChatHistory() {

  chatHistoryList.innerHTML =
    '';

  /*
    iOS keeps showing the old list when a fixed panel's
    contents change under it, so nudge a repaint.
  */
  nudgeRepaint(chatHistoryList);


  const needle =
    (chatSearch?.value || '')
      .trim()
      .toLowerCase();

  const visible =
    needle
      ? chats.filter(item =>
          String(item.title || '')
            .toLowerCase()
            .includes(needle)
        )
      : chats;

  if (needle && !visible.length) {

    const empty =
      document.createElement('div');

    empty.className = 'noMatches';

    empty.textContent =
      'No chats match that.';

    chatHistoryList.appendChild(empty);

  }

  visible.forEach(
    chatItem => {

      const row =
        document.createElement(
          'div'
        );

      row.dataset.chatId =
        String(chatItem.id);

      row.className =
        'chatHistoryItem' +
        (
          String(chatItem.id) ===
          String(currentChatId)
            ? ' active'
            : ''
        );


      const button =
        document.createElement(
          'button'
        );

      button.style.cssText =
        'flex:1;display:flex;align-items:center;gap:8px;background:none;border:0;color:inherit;text-align:left;padding:10px 0;min-width:0;';


      const title =
        document.createElement(
          'span'
        );

      title.className =
        'chatHistoryTitle';

      title.textContent =
        chatItem.title ||
        'New chat';


      button.appendChild(title);


      if (jobsForChat(chatItem.id).length) {

        const dot =
          document.createElement('div');

        dot.className = 'runningDot';

        dot.title = 'Still working in this chat';

        button.appendChild(dot);

      }


      button.addEventListener(
        'click',
        async () => {

          closeMobileSidebar();

          await loadChat(
            chatItem.id
          );

        }
      );


      const deleteButton =
        document.createElement(
          'button'
        );

      deleteButton.className =
        'deleteChatButton';

      deleteButton.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6"/><path d="M5.5 6l1 13.2A2 2 0 0 0 8.5 21h7a2 2 0 0 0 2-1.8L18.5 6"/><path d="M10 11v6M14 11v6"/></svg>';

      deleteButton.title =
        'Delete chat';

      deleteButton.setAttribute(
        'aria-label',
        `Delete ${chatItem.title || 'chat'}`
      );


      deleteButton.addEventListener(
        'click',
        event => {

          event.stopPropagation();

          askToDelete(row, chatItem);

        }
      );


      row.appendChild(button);

      row.appendChild(
        deleteButton
      );

      chatHistoryList.appendChild(
        row
      );

    }
  );

}


/* =====================================================
   CONFIRM DELETE

   The row turns into its own confirmation, so nothing
   is removed from the sidebar by a single stray tap.
===================================================== */

function askToDelete(row, chatItem) {

  row.classList.add('confirming');

  row.innerHTML = '';

  const wrap =
    document.createElement('div');

  wrap.className = 'confirmDelete';

  const text =
    document.createElement('div');

  text.className = 'confirmDeleteText';

  text.textContent =
    `Delete "${chatItem.title || 'New chat'}"?`;

  const yes =
    document.createElement('button');

  yes.className = 'confirmDeleteYes';

  yes.textContent = 'Delete';

  const no =
    document.createElement('button');

  no.className = 'confirmDeleteNo';

  no.textContent = 'Keep';

  yes.addEventListener(
    'click',
    async event => {

      event.stopPropagation();

      yes.disabled = true;

      yes.textContent = 'Deleting...';

      await deleteChat(chatItem.id);

    }
  );

  no.addEventListener(
    'click',
    event => {

      event.stopPropagation();

      renderChatHistory();

    }
  );

  wrap.appendChild(text);
  wrap.appendChild(no);
  wrap.appendChild(yes);

  row.appendChild(wrap);

}


/* =====================================================
   AFTER A DELETE

   Only the chat that was deleted goes. If the user is
   reading a different chat, that stays on screen.
===================================================== */

async function finishDelete(deletedChatId) {

  const wasOpen =
    isCurrentChat(deletedChatId);


  if (wasOpen) {

    imageState.clear();

    currentChatId = null;

  }


  /*
    The list comes back from the database, the same way a
    refresh builds it, so what you see after a delete is
    what is actually stored.
  */

  const loaded =
    await loadChats();


  /*
    Only if that read failed do we fall back to editing
    the list we already had.
  */

  if (loaded === false) {

    chats =
      chats.filter(
        item =>
          String(item.id) !== String(deletedChatId)
      );

  }


  if (wasOpen) {

    newChat({ keepSidebar: true });

  } else {

    renderChatHistory();

  }

}


function showDeleteFailure(chatId, message) {

  const row =
    [...chatHistoryList.children].find(
      item => item.dataset.chatId === String(chatId)
    );

  if (!row) {
    return;
  }

  row.classList.add('deleteFailed');

  const note =
    document.createElement('div');

  note.className = 'deleteFailedNote';

  note.textContent = message;

  row.appendChild(note);

}


chatSearch.addEventListener(
  'input',
  renderChatHistory
);


/* =====================================================
   FAST OR SMART
===================================================== */

const modeSwitchMenu =
  document.getElementById('modeSwitchMenu');

let paintedMode = null;

/* a sheen sweeps across the screen, left to right, when the mode changes */
function shineAcross(mode) {

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  document.querySelectorAll('.modeShine').forEach(old => old.remove());

  const shine = document.createElement('div');
  shine.className = `modeShine ${mode}`;
  shine.setAttribute('aria-hidden', 'true');
  document.body.appendChild(shine);

  shine.addEventListener('animationend', () => shine.remove());
  setTimeout(() => shine.remove(), 1500);

}

function paintMode() {

  if (paintedMode && paintedMode !== chatMode) {
    shineAcross(chatMode);
  }

  paintedMode = chatMode;

  document.body.classList.toggle(
    'smartMode',
    chatMode === 'smart'
  );


  [modeSwitch, modeSwitchMenu].forEach(group => {

    [...(group?.children || [])].forEach(button => {
      button.classList.toggle(
        'active',
        button.dataset.mode === chatMode
      );
    });

  });

}

function pickMode(event) {

  const button =
    event.target.closest('.modeButton');

  if (!button) return;

  chatMode = button.dataset.mode;

  try {
    localStorage.setItem('nastivee_mode', chatMode);
  } catch {}

  paintMode();

}

modeSwitch.addEventListener('click', pickMode);

modeSwitchMenu.addEventListener('click', event => {

  event.stopPropagation();

  pickMode(event);

});


/*
  On a phone the chip shows the dot and the number, and
  expands to the full wording when tapped. It folds back
  on its own, or when you tap elsewhere.
*/

let statusFoldTimer = null;

headerStatus.addEventListener('click', event => {

  event.stopPropagation();

  headerStatus.classList.toggle('expanded');

  clearTimeout(statusFoldTimer);

  if (headerStatus.classList.contains('expanded')) {

    statusFoldTimer = setTimeout(() => {
      headerStatus.classList.remove('expanded');
    }, 4000);

  }

});

document.addEventListener('click', () => {

  headerStatus.classList.remove('expanded');

  clearTimeout(statusFoldTimer);

});

paintMode();


/* =====================================================
   DELETE CHAT
===================================================== */

async function deleteChat(
  chatId
) {

  if (!currentUser && !guestMode) {
    return;
  }


  /*
    Never run a delete without knowing exactly which chat,
    so a missing id can never match more than one row.
  */

  if (
    chatId === undefined ||
    chatId === null ||
    chatId === ''
  ) {

    console.error('DELETE CHAT: no chat id supplied');

    renderChatHistory();

    return;

  }




  if (guestMode) {

    try {
      localStorage.removeItem(
        guestMessagesKey(chatId)
      );
    } catch {}

    saveGuestChats(
      guestChats().filter(
        item =>
          String(item.id) !== String(chatId)
      )
    );

    await finishDelete(chatId);

    return;

  }


  try {

    /*
      Delete by chat only. Row level security already limits
      this to your own rows, and filtering on user_id as well
      left behind any message row whose user_id was not set,
      which then blocked the chat from being deleted.
    */

    const {
      error: messageError
    } =
      await supabaseClient
        .from('messages')
        .delete()
        .eq(
          'chat_id',
          chatId
        );


    if (messageError) {
      throw messageError;
    }


    /*
      .select() makes the delete return the rows it removed.
      Without a delete policy, Supabase removes nothing and
      reports no error, which looked like the chat coming
      back to life in the sidebar.
    */

    const {
      data: removed,
      error: chatError
    } =
      await supabaseClient
        .from('chats')
        .delete()
        .eq(
          'id',
          chatId
        )
        .eq(
          'user_id',
          currentUser.id
        )
        .select();


    if (chatError) {
      throw chatError;
    }


    /*
      An empty result does not always mean failure: the
      rows a delete returns are themselves subject to row
      level security. So when nothing comes back, ask
      whether the chat is still there before complaining.
    */

    if (removed && removed.length > 1) {

      console.error(
        'DELETE CHAT: expected one row, removed',
        removed.length
      );

    }


    if (!removed || !removed.length) {

      const { data: stillThere } =
        await supabaseClient
          .from('chats')
          .select('id')
          .eq('id', chatId)
          .maybeSingle();

      if (stillThere) {

        throw new Error(
          'The database would not delete this chat. ' +
          'Check the delete policy on the chats table.'
        );

      }

    }


    await finishDelete(chatId);


  } catch (error) {

    console.error(
      'DELETE CHAT ERROR:',
      error
    );

    // put the row back, with the reason attached
    renderChatHistory();

    showDeleteFailure(
      chatId,
      error?.message || 'Could not delete this chat.'
    );

  }

}


/* =====================================================
   NEW CHAT
===================================================== */

/*
  The search box hides behind its icon until it is wanted.
*/

searchToggle?.addEventListener('click', () => {

  const open =
    !chatSearchWrap.classList.contains('open');

  chatSearchWrap.classList.toggle('open', open);
  searchToggle.classList.toggle('open', open);

  searchToggle.setAttribute(
    'aria-expanded',
    open ? 'true' : 'false'
  );

  if (open) {

    chatSearch.focus();

  } else if (chatSearch.value) {

    chatSearch.value = '';

    chatSearch.dispatchEvent(
      new Event('input')
    );

  }

});


newChatButton.addEventListener(
  'click',
  () => newChat()
);


function newChat(options = {}) {

  currentChatId = null;

  imageState.clear();

  refreshJobUI();

  headerTitle.textContent =
    'New chat';

  clearChatUI();

  setImageMode(false);

  clearUpload();

  renderChatHistory();

  /*
    After a delete the user is still reading the sidebar,
    and sliding it shut looks like every chat vanishing.
  */

  if (!options.keepSidebar) {

    closeMobileSidebar();

  }

}


/* =====================================================
   CLEAR CHAT UI
===================================================== */

function clearChatUI() {

  chat.innerHTML = '';

  emptyState =
    document.createElement(
      'div'
    );

  emptyState.className =
    'emptyState';

  emptyState.innerHTML = `
    <div class="emptyInner">
      <div class="emptyText">
        Ask me anything, upload an image to edit,
        or create something new, and I will remember
        the chat as we go.
      </div>
    </div>
  `;

  chat.appendChild(
    emptyState
  );

}


/* =====================================================
   ENSURE CHAT
===================================================== */

async function ensureChat(
  firstMessage = ''
) {

  if (currentChatId) {
    return currentChatId;
  }


  if (!currentUser && !guestMode) {
    throw new Error(
      'You are not logged in.'
    );
  }


  const title =
    firstMessage
      ? firstMessage
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 55)
      : 'New chat';


  if (guestMode) {

    const guestChat = {
      id: `g-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      title: title || 'New chat',
      created_at: new Date().toISOString()
    };

    const list = guestChats();

    list.unshift(guestChat);

    saveGuestChats(list);

    currentChatId = guestChat.id;

    headerTitle.textContent = guestChat.title;

    chats = list;

    renderChatHistory();

    return currentChatId;

  }


  const {
    data,
    error
  } =
    await supabaseClient
      .from('chats')
      .insert({

        user_id:
          currentUser.id,

        title:
          await encField(title || 'New chat')

      })
      .select()
      .single();


  if (error) {
    throw error;
  }


  currentChatId =
    data.id;

  headerTitle.textContent =
    data.title || 'New chat';


  chats.unshift(data);

  renderChatHistory();


  return currentChatId;

}


/* =====================================================
   LOAD CHAT
===================================================== */

async function loadChat(
  chatId
) {

  if (!currentUser && !guestMode) {
    return;
  }


  const sequence =
    ++loadSequence;


  currentChatId =
    chatId;

  imageState.clear();

  clearChatUI();


  const selectedChat =
    chats.find(
      item =>
        String(item.id) ===
        String(chatId)
    );


  headerTitle.textContent =
    selectedChat?.title ||
    'Chat';


  renderChatHistory();

  refreshJobUI();


  if (guestMode) {

    const stored = guestMessages(chatId);

    if (stored.length) {

      emptyState?.remove();

      stored.forEach(message => {

        if (message.role === 'user') {

          if (message.image_url) {

            addUserImage(
              chatId,
              message.image_url,
              message.content || ''
            );

          } else {

            addTextMessage('user', message.content || '');

          }

        } else if (message.image_url) {

          addImageMessage(
            message.image_url,
            message.content || '',
            message.image_url,
            message.content || ''
          );

        } else {

          addTextMessage(
            'assistant',
            message.content || ''
          );

        }

      });

      scrollToBottom();

    }

    return;

  }


  try {

    const {
      data,
      error
    } =
      await supabaseClient
        .from('messages')
        .select('*')
        .eq(
          'chat_id',
          chatId
        )
        .eq(
          'user_id',
          currentUser.id
        )
        .order(
          'created_at',
          {
            ascending: true
          }
        );


    if (error) {
      throw error;
    }


    if (sequence !== loadSequence) {
      return;
    }


    if (!data?.length) {

      return;

    }


    const rows =
      await decRows(data, ['content']);

    resealStale('messages', rows, ['content']);

    /* say once, plainly, why some messages cannot be read here */
    const lockedCount = rows.filter(row => row.__locked).length;

    if (lockedCount) {
      setTimeout(() => {
        if (!isCurrentChat(chatId) || chat.querySelector('.lockedNotice')) return;
        const note = document.createElement('div');
        note.className = 'messageRow assistant lockedNotice learnedRow';
        note.innerHTML = '<div class="learnedNote problem"></div>';
        note.firstChild.textContent =
          `${lockedCount} message${lockedCount === 1 ? ' was' : 's were'} sealed on another device. ` +
          'Open Natter once on that device and they will be moved across so you can read them here.';
        chat.prepend(note);
      }, 0);
    }


    emptyState?.remove();


    rows.forEach(
      message => {

        if (
          message.role ===
          'user'
        ) {

          if (message.image_url) {

            addUserImage(
              chatId,
              message.image_url,
              message.content || ''
            );

          } else {

            addTextMessage(
              'user',
              message.content || ''
            );

          }

        } else if (
          message.image_url
        ) {

          /*
            IMPORTANT:

            The saved image becomes BOTH
            the current source and the source
            available after refresh.

            Re-render will therefore continue
            from the latest generated image.
          */

          addImageMessage(
            message.image_url,
            message.content || '',
            message.image_url,
            message.content || ''
          );

        } else {

          addTextMessage(
            'assistant',
            message.content || ''
          );

        }

      }
    );


    scrollToBottom();


  } catch (error) {

    console.error(
      'LOAD CHAT ERROR:',
      error
    );

    addTextMessage(
      'assistant',
      `Could not load this chat:\n${error.message}`
    );

  }

}


/* =====================================================
   SAVE MESSAGE
===================================================== */

async function saveMessage(
  role,
  content,
  imageUrl = null,
  chatIdOverride = null,
  isRetry = false
) {

  const targetChatId =
    chatIdOverride ||
    currentChatId;


  if (guestMode) {

    if (!targetChatId) {
      return false;
    }

    const list = guestMessages(targetChatId);

    list.push({
      role,
      content: content || '',
      image_url: imageUrl || null,
      created_at: new Date().toISOString()
    });

    return saveGuestMessages(targetChatId, list);

  }


  if (
    !currentUser ||
    !targetChatId
  ) {

    console.error(
      'SAVE MESSAGE FAILED — missing user/chat:',
      {
        user:
          currentUser?.id,
        chatId:
          targetChatId
      }
    );

    return false;

  }


  try {

    const {
      error
    } =
      await supabaseClient
        .from('messages')
        .insert({

          chat_id:
            targetChatId,

          user_id:
            currentUser.id,

          role:
            role,

          content:
            await encField(content || ''),

          image_url:
            imageUrl || null

        });


    if (error) {

      console.error(
        'SUPABASE MESSAGE SAVE ERROR:',
        error
      );


      /*
        23503 is a foreign key violation: the chat this
        message belongs to is not there any more, usually
        because it was deleted while still open. Make a
        fresh chat and save into that instead of showing
        the user a database error.
      */

      if (error.code === '23503' && !isRetry) {

        if (isCurrentChat(targetChatId)) {

          currentChatId = null;

          const newId =
            await ensureChat(
              typeof content === 'string'
                ? content
                : ''
            );

          await loadChats();

          return saveMessage(
            role,
            content,
            imageUrl,
            newId,
            true
          );

        }

        return false;

      }


      if (
        String(currentChatId) ===
        String(targetChatId)
      ) {

        addTextMessage(
          'assistant',
          `Supabase save error:\n${error.message}`
        );

      }

      return false;

    }


    return true;


  } catch (error) {

    console.error(
      'MESSAGE SAVE EXCEPTION:',
      error
    );


    return false;

  }

}


/* =====================================================
   UPDATE CHAT TITLE
===================================================== */

async function updateChatTitle(
  chatId,
  title
) {

  if (!chatId) {
    return;
  }


  if (guestMode) {

    const list = guestChats().map(item =>
      String(item.id) === String(chatId)
        ? { ...item, title: title.slice(0, 55) }
        : item
    );

    saveGuestChats(list);

    chats = list;

    if (isCurrentChat(chatId)) {
      headerTitle.textContent = title.slice(0, 55);
    }

    renderChatHistory();

    return;

  }


  if (!currentUser) {
    return;
  }


  try {

    const {
      error
    } =
      await supabaseClient
        .from('chats')
        .update({
          title:
            await encField(title.slice(0, 55))
        })
        .eq(
          'id',
          chatId
        )
        .eq(
          'user_id',
          currentUser.id
        );


    if (error) {

      console.error(
        'TITLE UPDATE ERROR:',
        error
      );

      return;

    }


    const item =
      chats.find(
        chatItem =>
          String(chatItem.id) ===
          String(chatId)
      );


    if (item) {

      item.title =
        title.slice(0, 55);

    }


    if (
      String(currentChatId) ===
      String(chatId)
    ) {

      headerTitle.textContent =
        title.slice(0, 55);

    }


    renderChatHistory();


  } catch (error) {

    console.error(
      'TITLE UPDATE EXCEPTION:',
      error
    );

  }

}


/* =====================================================
   ADD TEXT MESSAGE
===================================================== */

/* =====================================================
   WHAT TO DO WITH AN ATTACHED PHOTO
===================================================== */

shapeRow.addEventListener('click', event => {

  const button =
    event.target.closest('.shapeButton');

  if (!button) return;

  imageShape = button.dataset.shape;

  [...shapeRow.querySelectorAll('.shapeButton')].forEach(item => {
    item.classList.toggle('active', item === button);
  });

});


photoChoice.addEventListener('click', event => {

  const button =
    event.target.closest('.photoChoiceButton');

  if (!button) return;

  photoAction =
    button.dataset.action;

  photoActionChosen = true;

  [...photoChoice.children].forEach(item => {
    item.classList.toggle(
      'active',
      item === button
    );
  });

  messageInput.placeholder =
    photoAction === 'ask'
      ? 'Ask a question about this photo...'
      : 'Describe what you want changed...';

  messageInput.focus();

});


/* =====================================================
   IMAGE STORAGE

   Generated images used to be kept as base64 text inside
   the database, about 1.4MB per picture. Now the file goes
   to Supabase Storage and only its address is stored, so
   chats load quickly and stay small.
===================================================== */

const IMAGE_BUCKET = 'images';

function dataUrlToBlob(dataUrl) {

  const [head, body] = String(dataUrl).split(',');

  if (!body) return null;

  const type =
    (head.match(/data:([^;]+)/) || [])[1] ||
    'image/png';

  const binary = atob(body);

  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type });

}


/*
  Returns a public URL for the image. Falls back to the
  data URL it was given if anything goes wrong, so an
  image is never lost to a storage problem.
*/
/*
  Opened pictures, so scrolling back through a chat does
  not download and decrypt the same file twice.
*/
const imageCache = new Map();


function blobToDataUrl(blob) {

  return new Promise((resolve, reject) => {

    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);

    reader.readAsDataURL(blob);

  });

}


/*
  An address in our own bucket, public or not. These are
  fetched through the signed in API so they keep working
  once the bucket stops being public.
*/
function storagePathFromUrl(ref) {

  if (typeof ref !== 'string') return null;

  const match =
    ref.match(
      new RegExp(
        `/storage/v1/object/(?:public/|sign/|authenticated/)?` +
        `${IMAGE_BUCKET}/([^?]+)`
      )
    );

  return match
    ? decodeURIComponent(match[1])
    : null;

}


/*
  Whatever is stored, hand back something an <img> can
  show and the API can send: always a data URL when it can
  be had, otherwise what came in.
*/
/*
  Pictures are kept as plain files now. Any sealed one that
  opens on this device is re-saved as an ordinary file, the
  chat is pointed at the new copy, and the sealed copy goes.
  After that every device can open it, whatever key it has.
*/
const unsealing = new Set();

async function unsealStoredImage(ref, type, sealedPath, plain) {

  if (!currentUser || guestMode || unsealing.has(ref)) return;

  unsealing.add(ref);

  try {

    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4' }[type];

    if (!ext) return;

    const path =
      `${currentUser.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { error: upError } =
      await supabaseClient.storage.from(IMAGE_BUCKET)
        .upload(path, new Blob([plain], { type }), { contentType: type, upsert: false });

    if (upError) throw upError;

    const { data } = supabaseClient.storage.from(IMAGE_BUCKET).getPublicUrl(path);

    const newRef = data?.publicUrl;

    if (!newRef) return;

    const { error: rowError } =
      await supabaseClient.from('messages')
        .update({ image_url: newRef })
        .eq('user_id', currentUser.id)
        .eq('image_url', ref);

    if (rowError) {
      await supabaseClient.storage.from(IMAGE_BUCKET).remove([path]);
      throw rowError;
    }

    if (imageCache.has(ref)) imageCache.set(newRef, imageCache.get(ref));

    await supabaseClient.storage.from(IMAGE_BUCKET).remove([sealedPath]);

  } catch (error) {

    console.warn('UNSEAL IMAGE FAILED:', error?.message);
    unsealing.delete(ref);

  }

}


async function resolveImage(ref) {

  if (typeof ref !== 'string' || !ref) return ref;

  if (ref.startsWith('data:')) return ref;

  if (imageCache.has(ref)) return imageCache.get(ref);

  if (ref.startsWith('encimg:')) {

    const firstColon = ref.indexOf(':');
    const secondColon = ref.indexOf(':', firstColon + 1);

    const type =
      ref.slice(firstColon + 1, secondColon);

    const path =
      ref.slice(secondColon + 1);

    if (!dataKey) {
      throw new Error('Unlock your chats to see this picture.');
    }

    const { data, error } =
      await supabaseClient
        .storage
        .from(IMAGE_BUCKET)
        .download(path);

    if (error) throw error;

    const plain =
      await decBytes(
        new Uint8Array(await data.arrayBuffer())
      );

    /* a video plays far better from a blob than a data URL */
    const url =
      type.startsWith('video/')
        ? URL.createObjectURL(new Blob([plain], { type }))
        : await blobToDataUrl(new Blob([plain], { type }));

    imageCache.set(ref, url);

    /* sealed pictures are turned into ordinary files as they are opened */
    unsealStoredImage(ref, type, path, plain);

    return url;

  }

  const legacyPath =
    storagePathFromUrl(ref);

  if (legacyPath && currentUser && !guestMode) {

    const { data, error } =
      await supabaseClient
        .storage
        .from(IMAGE_BUCKET)
        .download(legacyPath);

    if (!error && data) {

      const url =
        /\.mp4$/i.test(legacyPath) || (data.type || '').startsWith('video/')
          ? URL.createObjectURL(data.type ? data : new Blob([data], { type: 'video/mp4' }))
          : await blobToDataUrl(data);

      imageCache.set(ref, url);

      return url;

    }

  }

  return ref;

}


/*
  Puts a stored picture into an <img>, showing a quiet
  placeholder while a sealed one is opened.
*/
function setImageSource(img, ref) {

  const needsWork =
    typeof ref === 'string' &&
    (ref.startsWith('encimg:') || storagePathFromUrl(ref));

  if (!needsWork) {
    img.src = ref;
    return;
  }

  if (imageCache.has(ref)) {
    img.src = imageCache.get(ref);
    return;
  }

  img.classList.add('imageLoading');

  resolveImage(ref)
    .then(url => {
      img.src = url;
    })
    .catch(error => {

      console.error('IMAGE OPEN ERROR:', error);

      img.classList.add('imageFailed');

      img.alt = 'This picture could not be opened';

    })
    .finally(() => {
      img.classList.remove('imageLoading');
    });

}


/* =====================================================
   SEALING WHAT CAME BEFORE

   Anything written before encryption existed is still
   readable in the database. Once the vault is open, this
   goes back through and seals it, quietly, a row at a
   time. It is safe to stop half way and pick up again on
   the next visit, because each row is only ever touched
   if it is still plain.
===================================================== */

let sealingOldData = false;


/*
  Moves one old picture into sealed storage. Hands back
  the new reference and the old file to remove, but does
  not remove it, so a row that fails to update is never
  left pointing at nothing.
*/
async function sealLegacyImage(ref) {

  try {

    const opened =
      await resolveImage(ref);

    if (typeof opened !== 'string' || !opened.startsWith('data:')) {
      return null;
    }

    const sealedRef =
      await storeImage(opened);

    if (typeof sealedRef !== 'string' ||
        !sealedRef.startsWith('encimg:')) {
      return null;
    }

    return {
      ref: sealedRef,
      oldPath: storagePathFromUrl(ref)
    };

  } catch (error) {

    console.warn('OLD PICTURE NOT SEALED:', error);

    return null;

  }

}


async function encryptLegacy() {

  if (
    sealingOldData ||
    !dataKey ||
    guestMode ||
    !currentUser ||
    !cryptoReady()
  ) {
    return;
  }

  sealingOldData = true;

  const uid = currentUser.id;

  let sealed = 0;

  try {

    /* 1. chat titles */

    const { data: chatRows, error: chatError } =
      await supabaseClient
        .from('chats')
        .select('id,title')
        .eq('user_id', uid);

    if (chatError) throw chatError;

    for (const row of chatRows || []) {

      if (!row.title || row.title.startsWith(ENC_PREFIX)) continue;

      const { error } =
        await supabaseClient
          .from('chats')
          .update({ title: await encField(row.title) })
          .eq('id', row.id)
          .eq('user_id', uid);

      if (error) throw error;

      sealed += 1;

    }


    /* 2. message text and pictures, a page at a time */

    const PAGE = 400;

    for (let from = 0; from < 20000; from += PAGE) {

      const { data: rows, error: pageError } =
        await supabaseClient
          .from('messages')
          .select('id,content,image_url')
          .eq('user_id', uid)
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1);

      if (pageError) throw pageError;

      for (const row of rows || []) {

        const patch = {};

        let oldPath = null;

        if (row.content && !row.content.startsWith(ENC_PREFIX)) {
          patch.content = await encField(row.content);
        }

        /* pictures stay as they are: JPEG, PNG or WebP, never sealed */
        if (false && row.image_url && !row.image_url.startsWith('encimg:')) {

          const moved =
            await sealLegacyImage(row.image_url);

          if (moved) {
            patch.image_url = moved.ref;
            oldPath = moved.oldPath;
          }

        }

        if (!Object.keys(patch).length) continue;

        const { error } =
          await supabaseClient
            .from('messages')
            .update(patch)
            .eq('id', row.id)
            .eq('user_id', uid);

        if (error) throw error;

        sealed += 1;

        /* only now is the readable copy safe to remove */
        if (oldPath) {

          await supabaseClient
            .storage
            .from(IMAGE_BUCKET)
            .remove([oldPath]);

        }

      }

      if (!rows || rows.length < PAGE) break;

    }


    /* 3. profile notes */

    const { data: profile } =
      await supabaseClient
        .from('profiles')
        .select('memory')
        .eq('id', uid)
        .maybeSingle();

    if (profile?.memory && !profile.memory.startsWith(ENC_PREFIX)) {

      const { error } =
        await supabaseClient
          .from('profiles')
          .update({ memory: await encField(profile.memory) })
          .eq('id', uid);

      if (error) throw error;

      sealed += 1;

    }

    if (sealed) {
      console.log(`SEALED ${sealed} OLDER ITEMS`);
    }

  } catch (error) {

    /*
      Stopping here is safe. Whatever was sealed stays
      sealed, and the rest is picked up next time.
    */
    console.error('SEALING STOPPED, WILL RESUME:', error);

  } finally {

    sealingOldData = false;

  }

}


async function storeImage(dataUrl) {

  if (
    guestMode ||
    !currentUser ||
    typeof dataUrl !== 'string' ||
    !dataUrl.startsWith('data:')
  ) {
    return dataUrl;
  }

  try {

    const blob = dataUrlToBlob(dataUrl);

    if (!blob) return dataUrl;

    /*
      With the vault open, the picture is sealed here before
      it leaves the browser, and stored privately. What the
      chat keeps is a reference only this account can open.
    */
    /*
      Pictures are no longer sealed. They are stored as plain
      JPEG, PNG or WebP files in the private bucket, which only
      this account can open. (Clips stay MP4.) Pictures sealed
      before this change still open as before.
    */
    if (false && dataKey && cryptoReady()) {

      const sealed =
        await encBytes(
          new Uint8Array(await blob.arrayBuffer())
        );

      const sealedPath =
        `${currentUser.id}/${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}.enc`;

      const { error: sealError } =
        await supabaseClient
          .storage
          .from(IMAGE_BUCKET)
          .upload(
            sealedPath,
            new Blob([sealed], {
              type: 'application/octet-stream'
            }),
            {
              contentType: 'application/octet-stream',
              upsert: false
            }
          );

      if (sealError) throw sealError;

      const ref =
        `encimg:${blob.type || 'image/png'}:${sealedPath}`;

      /* we already have the picture, no need to fetch it back */
      imageCache.set(ref, dataUrl);

      return ref;

    }

    const allowed = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'video/mp4': 'mp4'
    };

    let upload = blob;
    let type = (blob.type || '').toLowerCase();

    /* anything else is turned into a PNG first */
    if (!allowed[type] && type.startsWith('image/')) {
      try {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        upload = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        type = 'image/png';
      } catch {
        return dataUrl;
      }
    }

    if (!allowed[type]) return dataUrl;

    const extension = allowed[type];

    const path =
      `${currentUser.id}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${extension}`;

    const { error } =
      await supabaseClient
        .storage
        .from(IMAGE_BUCKET)
        .upload(path, upload, {
          contentType: type,
          upsert: false
        });

    if (error) throw error;

    const { data } =
      supabaseClient
        .storage
        .from(IMAGE_BUCKET)
        .getPublicUrl(path);

    /* we already have it, no need to fetch it back to show it */
    if (data?.publicUrl) imageCache.set(data.publicUrl, dataUrl);

    return data?.publicUrl || dataUrl;

  } catch (error) {

    console.error('IMAGE STORE ERROR:', error);

    return dataUrl;

  }

}


/* =====================================================
   API HEADERS

   Image routes need a signed in user, so every call
   carries the Supabase access token when there is one.
===================================================== */

async function apiHeaders() {

  const headers = {
    'Content-Type': 'application/json'
  };

  if (guestMode) {
    return headers;
  }

  try {

    const { data } =
      await supabaseClient.auth.getSession();

    const token =
      data?.session?.access_token;

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

  } catch {}

  return headers;

}


/* =====================================================
   MARKDOWN

   Everything is escaped first, then a small set of marks
   is turned back into HTML. No library, nothing from the
   text is ever treated as markup.
===================================================== */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


/* =====================================================
   ANSWER CARDS

   Some things read far better as a picture than as a
   paragraph: the weather, a football score, a league
   table, a price. Natter sends those as a small block of
   data and the app draws them as a card.
===================================================== */

const CARD_QUEUE = [];

/* the weather pictures, drawn here so they move and never load */
const CARD_ICONS = {

  sun: `<svg viewBox="0 0 48 48" class="wIcon sun"><g class="rays" stroke="#ffd166" stroke-width="3" stroke-linecap="round"><path d="M24 3v6M24 39v6M3 24h6M39 24h6M9 9l4 4M35 35l4 4M39 9l-4 4M13 35l-4 4"/></g><circle cx="24" cy="24" r="10" fill="#ffc531"/><circle cx="20.5" cy="20.5" r="3.4" fill="#ffe79a" opacity=".8"/></svg>`,

  moon: `<svg viewBox="0 0 48 48" class="wIcon"><path d="M31 6a18 18 0 1 0 11 24A14 14 0 0 1 31 6Z" fill="#cbd8ff"/><circle cx="34" cy="20" r="2.4" fill="#aebbe6"/><circle cx="27" cy="29" r="1.6" fill="#aebbe6"/></svg>`,

  cloud: `<svg viewBox="0 0 48 48" class="wIcon"><g class="drift"><ellipse cx="19" cy="28" rx="13" ry="10" fill="#9fb0cc"/><ellipse cx="30" cy="30" rx="11" ry="8" fill="#b9c7de"/><ellipse cx="25" cy="23" rx="9" ry="8" fill="#cbd6e8"/></g></svg>`,

  partly: `<svg viewBox="0 0 48 48" class="wIcon"><circle cx="31" cy="16" r="8" fill="#ffc531"/><g class="rays" stroke="#ffd166" stroke-width="2.6" stroke-linecap="round"><path d="M31 2v4M45 16h-4M41 6l-3 3M41 26l-3-3"/></g><g class="drift"><ellipse cx="18" cy="31" rx="12" ry="9" fill="#9fb0cc"/><ellipse cx="29" cy="33" rx="10" ry="7" fill="#b9c7de"/><ellipse cx="23" cy="26" rx="8" ry="7" fill="#cbd6e8"/></g></svg>`,

  rain: `<svg viewBox="0 0 48 48" class="wIcon"><g class="drift"><ellipse cx="18" cy="21" rx="12" ry="9" fill="#8ea0bd"/><ellipse cx="29" cy="23" rx="10" ry="7" fill="#aab9d2"/><ellipse cx="23" cy="16" rx="8" ry="7" fill="#c3cee0"/></g><g stroke="#5bb8ff" stroke-width="3" stroke-linecap="round"><path class="drop d1" d="M15 33v5"/><path class="drop d2" d="M24 33v6"/><path class="drop d3" d="M33 33v5"/></g></svg>`,

  showers: `<svg viewBox="0 0 48 48" class="wIcon"><circle cx="34" cy="13" r="6.5" fill="#ffc531"/><g class="drift"><ellipse cx="18" cy="22" rx="12" ry="9" fill="#8ea0bd"/><ellipse cx="29" cy="24" rx="10" ry="7" fill="#aab9d2"/><ellipse cx="23" cy="17" rx="8" ry="7" fill="#c3cee0"/></g><g stroke="#5bb8ff" stroke-width="3" stroke-linecap="round"><path class="drop d1" d="M16 34v5"/><path class="drop d3" d="M27 34v5"/></g></svg>`,

  storm: `<svg viewBox="0 0 48 48" class="wIcon"><g class="drift"><ellipse cx="18" cy="20" rx="12" ry="9" fill="#75839c"/><ellipse cx="29" cy="22" rx="10" ry="7" fill="#8b99b3"/><ellipse cx="23" cy="15" rx="8" ry="7" fill="#a6b2c8"/></g><path class="bolt" d="M25 29l-8 10h6l-3 8 11-12h-6l4-6Z" fill="#ffd166"/></svg>`,

  snow: `<svg viewBox="0 0 48 48" class="wIcon"><g class="drift"><ellipse cx="18" cy="21" rx="12" ry="9" fill="#9fb0cc"/><ellipse cx="29" cy="23" rx="10" ry="7" fill="#b9c7de"/><ellipse cx="23" cy="16" rx="8" ry="7" fill="#d5dfee"/></g><g fill="#e9f3ff"><circle class="flake d1" cx="16" cy="36" r="2.4"/><circle class="flake d2" cx="25" cy="38" r="2.4"/><circle class="flake d3" cx="34" cy="36" r="2.4"/></g></svg>`,

  fog: `<svg viewBox="0 0 48 48" class="wIcon"><g class="drift"><ellipse cx="22" cy="19" rx="13" ry="9" fill="#a9b6c9"/></g><g stroke="#cbd6e8" stroke-width="3.4" stroke-linecap="round"><path class="mist m1" d="M9 31h30"/><path class="mist m2" d="M12 38h26"/></g></svg>`,

  wind: `<svg viewBox="0 0 48 48" class="wIcon"><g stroke="#cbd6e8" stroke-width="3.2" fill="none" stroke-linecap="round"><path class="mist m1" d="M6 18h22a5 5 0 1 0-5-5"/><path class="mist m2" d="M6 28h28a5 5 0 1 1-5 5"/><path class="mist m1" d="M8 38h14"/></g></svg>`

};

function cardIcon(name) {
  return CARD_ICONS[name] || CARD_ICONS.cloud;
}

function cardEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

/* a row of buttons that ask the obvious next question */
function cardChips(card, box) {
  if (!Array.isArray(card.chips) || !card.chips.length) return;
  const row = cardEl('div', 'cardChips');
  card.chips.slice(0, 4).forEach(chip => {
    const text = typeof chip === 'string' ? chip : chip?.label;
    if (!text) return;
    const button = cardEl('button', 'cardChip', text);
    button.type = 'button';
    button.addEventListener('click', () => {
      const ask = (typeof chip === 'object' && chip.ask) || text;
      if (typeof messageInput !== 'undefined' && messageInput) {
        messageInput.value = ask;
        messageInput.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('sendButton')?.click();
      }
    });
    row.appendChild(button);
  });
  box.appendChild(row);
}

function cardFacts(rows, box, className = 'cardFacts') {
  if (!Array.isArray(rows) || !rows.length) return;
  const grid = cardEl('div', className);
  rows.slice(0, 8).forEach(row => {
    const pair = Array.isArray(row) ? row : [row?.label, row?.value];
    if (!pair[0] && !pair[1]) return;
    const item = cardEl('div', 'cardFact');
    item.appendChild(cardEl('span', 'cardFactLabel', pair[0] ?? ''));
    item.appendChild(cardEl('span', 'cardFactValue', pair[1] ?? ''));
    grid.appendChild(item);
  });
  box.appendChild(grid);
}

function buildWeatherCard(card, box) {

  box.classList.add('weatherCard');

  const head = cardEl('div', 'cardTop');

  const icon = cardEl('div', 'cardBigIcon');
  icon.innerHTML = cardIcon(card.now?.icon);
  head.appendChild(icon);

  const text = cardEl('div', 'cardTopText');
  text.appendChild(cardEl('div', 'cardTemp', card.now?.temp ?? ''));
  text.appendChild(cardEl('div', 'cardWhere', card.place ?? ''));
  text.appendChild(cardEl('div', 'cardWhat', card.now?.text ?? ''));
  head.appendChild(text);

  box.appendChild(head);

  cardFacts(card.facts, box);

  if (Array.isArray(card.hours) && card.hours.length) {
    const strip = cardEl('div', 'cardStrip');
    card.hours.slice(0, 8).forEach(hour => {
      const cell = cardEl('div', 'cardStripCell');
      cell.appendChild(cardEl('div', 'cardStripTop', hour.time ?? ''));
      const small = cardEl('div', 'cardStripIcon');
      small.innerHTML = cardIcon(hour.icon);
      cell.appendChild(small);
      cell.appendChild(cardEl('div', 'cardStripValue', hour.temp ?? ''));
      if (hour.rain) cell.appendChild(cardEl('div', 'cardStripRain', hour.rain));
      strip.appendChild(cell);
    });
    box.appendChild(strip);
  }

  if (Array.isArray(card.days) && card.days.length) {
    const list = cardEl('div', 'cardDays');
    card.days.slice(0, 7).forEach(day => {
      const line = cardEl('div', 'cardDay');
      line.appendChild(cardEl('span', 'cardDayName', day.day ?? ''));
      const small = cardEl('span', 'cardDayIcon');
      small.innerHTML = cardIcon(day.icon);
      line.appendChild(small);
      line.appendChild(cardEl('span', 'cardDayHigh', day.high ?? ''));
      line.appendChild(cardEl('span', 'cardDayLow', day.low ?? ''));
      list.appendChild(line);
    });
    box.appendChild(list);
  }

}

function teamBadge(name) {
  const badge = cardEl('div', 'cardBadge');
  const initials = String(name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map(word => word[0])
    .join('')
    .toUpperCase();
  badge.textContent = initials;
  return badge;
}

function buildScoreCard(card, box) {

  box.classList.add('scoreCard');

  const top = cardEl('div', 'cardLine');
  if (card.competition) top.appendChild(cardEl('span', 'cardTag', card.competition));
  if (card.status) {
    const live = /^\d+'|live|ht$/i.test(String(card.status));
    top.appendChild(cardEl('span', `cardStatus${live ? ' live' : ''}`, card.status));
  }
  if (card.when && !card.status) top.appendChild(cardEl('span', 'cardStatus', card.when));
  box.appendChild(top);

  const grid = cardEl('div', 'scoreGrid');

  [card.home, card.away].forEach((side, i) => {
    const team = cardEl('div', 'scoreTeam');
    team.appendChild(teamBadge(side?.name));
    team.appendChild(cardEl('div', 'scoreName', side?.name ?? ''));
    grid.appendChild(team);
    if (i === 0) {
      const numbers = cardEl('div', 'scoreNumbers');
      numbers.appendChild(cardEl('span', 'scoreValue', card.home?.score ?? '-'));
      numbers.appendChild(cardEl('span', 'scoreDash', '–'));
      numbers.appendChild(cardEl('span', 'scoreValue', card.away?.score ?? '-'));
      grid.appendChild(numbers);
    }
  });

  box.appendChild(grid);

  if (Array.isArray(card.notes) && card.notes.length) {
    const list = cardEl('div', 'cardNotes');
    card.notes.slice(0, 8).forEach(note => list.appendChild(cardEl('div', 'cardNote', note)));
    box.appendChild(list);
  }

  cardFacts(card.facts, box);

}

function buildTableCard(card, box) {

  box.classList.add('tableCard');

  if (card.title) box.appendChild(cardEl('div', 'cardTitle', card.title));

  const table = cardEl('table', 'cardTable');

  if (Array.isArray(card.columns) && card.columns.length) {
    const head = cardEl('thead');
    const row = cardEl('tr');
    card.columns.forEach(name => row.appendChild(cardEl('th', '', name)));
    head.appendChild(row);
    table.appendChild(head);
  }

  const body = cardEl('tbody');

  (card.rows || []).slice(0, 25).forEach(cells => {
    const row = cardEl('tr');
    if (card.highlight && cells.some(cell => String(cell) === String(card.highlight))) {
      row.className = 'cardTableMine';
    }
    (cells || []).forEach(cell => row.appendChild(cardEl('td', '', cell)));
    body.appendChild(row);
  });

  table.appendChild(body);
  box.appendChild(table);

}

function buildStatCard(card, box) {

  box.classList.add('statCard');

  if (card.title) box.appendChild(cardEl('div', 'cardTitle', card.title));

  const line = cardEl('div', 'statLine');
  line.appendChild(cardEl('span', 'statValue', card.value ?? ''));

  if (card.change) {
    const up = card.direction === 'up' || /^\+/.test(String(card.change));
    const down = card.direction === 'down' || /^-/.test(String(card.change));
    line.appendChild(cardEl('span', `statChange${up ? ' up' : down ? ' down' : ''}`, card.change));
  }

  box.appendChild(line);

  /* a little line drawing of the numbers, if they were sent */
  if (Array.isArray(card.spark) && card.spark.length > 1) {
    const numbers = card.spark.map(Number).filter(Number.isFinite);
    if (numbers.length > 1) {
      const low = Math.min(...numbers);
      const high = Math.max(...numbers);
      const span = high - low || 1;
      const points = numbers
        .map((value, i) => `${(i / (numbers.length - 1) * 100).toFixed(1)},${(26 - (value - low) / span * 24).toFixed(1)}`)
        .join(' ');
      const spark = cardEl('div', 'cardSpark');
      spark.innerHTML =
        `<svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">` +
        `<polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
      box.appendChild(spark);
    }
  }

  cardFacts(card.rows || card.facts, box);

}

function buildFactsCard(card, box) {

  box.classList.add('factsCard');

  if (card.title) {
    const title = cardEl('div', 'cardTitle');
    if (card.icon) title.appendChild(cardEl('span', 'cardTitleIcon', card.icon));
    title.appendChild(cardEl('span', '', card.title));
    box.appendChild(title);
  }

  if (card.subtitle) box.appendChild(cardEl('div', 'cardWhat', card.subtitle));

  cardFacts(card.rows || card.facts, box, 'cardFacts wide');

}

/* =====================================================
   MUSIC PAPER

   A tune, a scale or a riff drawn on real manuscript
   paper: staves, clef, key, time signature, notes with
   stems and flags, bar lines, and words under the notes.
===================================================== */

const MUSIC_LETTERS = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

const MUSIC_CLEFS = {
  treble: { bottom: 30, label: 'treble' },   /* E4 on the bottom line */
  bass: { bottom: 18, label: 'bass' }        /* G2 on the bottom line */
};

/* "F#4" or "Bb3" or "C4" into a step number and an accidental */
function musicPitch(text) {
  const match = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(text || '').trim());
  if (!match) return null;
  const letter = MUSIC_LETTERS[match[1].toUpperCase()];
  return {
    step: Number(match[3]) * 7 + letter,
    accidental: match[2] === '#' ? '♯' : match[2] === 'b' ? '♭' : ''
  };
}

function musicLength(value) {
  const text = String(value || 'q').toLowerCase();
  const dotted = text.includes('.');
  const base = text.replace('.', '');
  const kinds = {
    w: { beats: 4, hollow: true, stem: false, flags: 0 },
    h: { beats: 2, hollow: true, stem: true, flags: 0 },
    q: { beats: 1, hollow: false, stem: true, flags: 0 },
    e: { beats: .5, hollow: false, stem: true, flags: 1 },
    s: { beats: .25, hollow: false, stem: true, flags: 2 }
  };
  const kind = kinds[base] || kinds.q;
  return { ...kind, dotted };
}

const TREBLE_CLEF = 'M8.2 37.4c-3.1-1.6-5-4.4-5-7.6 0-4 3-7.2 7.2-7.2 1 0 1.9.2 2.7.5l-.7-4.6C8.6 15.2 5 11.4 5 6.9 5 3.4 7.3.5 9.9.5c2.2 0 3.6 2.3 4 5.2.4 3-.6 5.9-2.6 8.6l.8 5.2c.6-.1 1.2-.2 1.8-.2 4.6 0 8.1 3.3 8.1 8 0 4.2-3 7.3-7 7.9l.6 4c.5 3.4-1.5 6.3-4.6 6.3-2.6 0-4.6-1.9-4.6-4.3 0-1.9 1.4-3.3 3.1-3.3 1.6 0 2.9 1.2 2.9 2.8 0 1.5-1.1 2.6-2.5 2.7.5.6 1.3 1 2.2 1 1.9 0 3.1-1.8 2.7-4.3l-.6-3.9c-.6.1-1.2.1-1.8.1-1.4 0-2.7-.2-3.9-.6zM10.4 3c-1.6 1.9-2.6 4.4-2.6 6.6 0 2.4 1.1 4.3 3 5.6 1.4-2 2.2-4.3 2.2-6.4 0-3.1-.9-5-2.6-5.8zm.3 21.4c-2.9 0-5.1 2.3-5.1 5.2 0 2.4 1.5 4.5 3.8 5.6l-1.6-10.6c.4-.1.6-.2.9-.2zm2.1.3l1.6 10.6c2.6-.5 4.4-2.7 4.4-5.4 0-3-2.4-5.3-5.5-5.3-.2 0-.3 0-.5.1z';

function musicClefGlyph(box, clef, y, gap) {
  if (clef === 'bass') {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.innerHTML =
      `<circle cx="9" cy="${y + gap}" r="2" fill="#1d1a17"/>` +
      `<circle cx="17" cy="${y + gap * .6}" r="1.5" fill="#1d1a17"/>` +
      `<circle cx="17" cy="${y + gap * 1.6}" r="1.5" fill="#1d1a17"/>` +
      `<path d="M9 ${y + gap} a10 10 0 0 1 0 ${gap * 3.6}" fill="none" stroke="#1d1a17" stroke-width="3.4" stroke-linecap="round"/>`;
    return g;
  }
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  /* the clef stands about six line gaps tall, sitting a gap above the top line */
  const scale = (gap * 6.2) / 44;
  g.setAttribute('transform', `translate(10 ${y - gap * 1.1}) scale(${scale.toFixed(3)})`);
  g.innerHTML = `<path d="${TREBLE_CLEF}" fill="#1d1a17"/>`;
  return g;
}

function buildMusicCard(card, box) {

  box.classList.add('musicCard');

  if (card.title) {
    const title = cardEl('div', 'musicTitle', card.title);
    box.appendChild(title);
  }

  const under = [card.composer, card.key ? `Key of ${card.key}` : '', card.tempo]
    .filter(Boolean)
    .join(' · ');

  if (under) box.appendChild(cardEl('div', 'musicSub', under));

  const notes = Array.isArray(card.notes) ? card.notes.slice(0, 96) : [];

  if (!notes.length) return;

  const clef = MUSIC_CLEFS[card.clef === 'bass' ? 'bass' : 'treble'];

  /* the paper */
  const gap = 9;                       /* between stave lines */
  const step = gap / 2;                /* one note step */
  const startX = 74;                   /* after the clef and time signature */
  const noteGap = 30;
  const width = 560;
  const perRow = Math.max(4, Math.floor((width - startX - 16) / noteGap));
  const rows = [];

  for (let i = 0; i < notes.length; i += perRow) {
    rows.push(notes.slice(i, i + perRow));
  }

  const rowHeight = 92;
  const height = rows.length * rowHeight + 16;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'musicPaper');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${card.title || 'Music'}, written on a stave`);

  const add = (markup) => { svg.insertAdjacentHTML('beforeend', markup); };

  rows.forEach((row, rowIndex) => {

    const top = 20 + rowIndex * rowHeight;
    const bottomLine = top + gap * 4;

    /* five lines */
    for (let line = 0; line < 5; line += 1) {
      const y = top + line * gap;
      add(`<line x1="8" y1="${y}" x2="${width - 10}" y2="${y}" stroke="#4a4038" stroke-width="1"/>`);
    }

    svg.appendChild(musicClefGlyph(svg, card.clef === 'bass' ? 'bass' : 'treble', top, gap));

    if (card.time) {
      const parts = String(card.time).split('/');
      add(`<text x="52" y="${top + gap * 1.95}" class="musicTime" fill="#1d1a17">${escapeHtml(parts[0] || '4')}</text>`);
      add(`<text x="52" y="${top + gap * 3.95}" class="musicTime" fill="#1d1a17">${escapeHtml(parts[1] || '4')}</text>`);
    }

    let x = startX;

    row.forEach(item => {

      if (item?.bar) {
        add(`<line x1="${x - noteGap * .35}" y1="${top}" x2="${x - noteGap * .35}" y2="${bottomLine}" stroke="#4a4038" stroke-width="1.6"/>`);
        x += noteGap * .35;
        return;
      }

      const pitch = musicPitch(item?.p ?? item?.pitch ?? item);
      const length = musicLength(item?.d ?? item?.length);

      if (!pitch) {
        /* a rest: a small block on the middle line */
        add(`<rect x="${x - 5}" y="${top + gap * 1.6}" width="10" height="4" fill="#1d1a17"/>`);
        x += noteGap;
        return;
      }

      const y = bottomLine - (pitch.step - clef.bottom) * step;

      /* ledger lines above and below */
      for (let ly = bottomLine + gap; ly <= y + 0.1; ly += gap) {
        add(`<line x1="${x - 9}" y1="${ly}" x2="${x + 9}" y2="${ly}" stroke="#4a4038" stroke-width="1"/>`);
      }
      for (let ly = top - gap; ly >= y - 0.1; ly -= gap) {
        add(`<line x1="${x - 9}" y1="${ly}" x2="${x + 9}" y2="${ly}" stroke="#4a4038" stroke-width="1"/>`);
      }

      if (pitch.accidental) {
        add(`<text x="${x - 16}" y="${y + 4}" class="musicAccidental">${pitch.accidental}</text>`);
      }

      add(
        `<ellipse cx="${x}" cy="${y}" rx="6.2" ry="4.6" transform="rotate(-20 ${x} ${y})" ` +
        `fill="${length.hollow ? 'none' : '#1d1a17'}" stroke="#1d1a17" stroke-width="${length.hollow ? 2 : 1}"/>`
      );

      if (length.dotted) {
        add(`<circle cx="${x + 11}" cy="${y - 2}" r="1.7" fill="#1d1a17"/>`);
      }

      if (length.stem) {
        const up = y > top + gap * 2;
        const stemX = up ? x + 5.8 : x - 5.8;
        const stemY = up ? y - 26 : y + 26;
        add(`<line x1="${stemX}" y1="${y}" x2="${stemX}" y2="${stemY}" stroke="#1d1a17" stroke-width="1.6"/>`);
        for (let flag = 0; flag < length.flags; flag += 1) {
          /* the flag curls away from the note, whichever way the stem points */
          const way = up ? 1 : -1;
          const fy = stemY + way * flag * 6;
          add(
            `<path d="M${stemX} ${fy} q7 ${way * 4} 6 ${way * 11} q-2 ${way * -6} -6 ${way * -7} Z" fill="#1d1a17"/>`
          );
        }
      }

      if (item?.l || item?.lyric) {
        add(
          `<text x="${x}" y="${top + gap * 4 + 30}" class="musicLyric" fill="#3a322a">${escapeHtml(String(item.l || item.lyric))}</text>`
        );
      }

      x += noteGap;

    });

    /* the line ends with a bar line */
    add(`<line x1="${width - 10}" y1="${top}" x2="${width - 10}" y2="${bottomLine}" stroke="#4a4038" stroke-width="1.6"/>`);

  });

  const paper = cardEl('div', 'musicSheet');
  paper.appendChild(svg);
  box.appendChild(paper);

  if (card.note) box.appendChild(cardEl('div', 'musicNote', card.note));

}

const CARD_BUILDERS = {
  weather: buildWeatherCard,
  score: buildScoreCard,
  fixture: buildFactsCard,
  table: buildTableCard,
  stat: buildStatCard,
  facts: buildFactsCard,
  music: buildMusicCard
};

function buildCard(card) {

  const build = CARD_BUILDERS[card?.card];

  if (!build) return null;

  const box = cardEl('div', 'answerCard');

  try {
    build(card, box);
    cardChips(card, box);
  } catch (error) {
    console.error('CARD ERROR:', error);
    return null;
  }

  return box;

}

/* fills in any card places left by the last render */
function paintCards() {

  document.querySelectorAll('.cardSlot:not(.done)').forEach(slot => {

    slot.classList.add('done');

    const card = CARD_QUEUE[Number(slot.dataset.card)];
    const built = card && buildCard(card);

    if (built) {
      slot.replaceWith(built);
    } else {
      slot.remove();
    }

  });

}


function renderMarkdown(text) {

  const codeBlocks = [];

  let source = text || '';

  /*
    Card blocks. While a reply is still arriving the block
    may be half written, so an unfinished one is held back
    rather than shown as raw text.
  */
  const unfinished = source.lastIndexOf('```natter');

  if (unfinished > -1 && !/```/.test(source.slice(unfinished + 9))) {
    source = source.slice(0, unfinished);
  }

  source = source.replace(/```natter\s*\n?([\s\S]*?)```/g, (match, body) => {
    try {
      const card = JSON.parse(body);
      CARD_QUEUE.push(card);
      return `\u0000CARD${CARD_QUEUE.length - 1}\u0000`;
    } catch {
      return '';
    }
  });

  let out = escapeHtml(source);

  // fenced code, held aside so nothing else touches it
  out = out.replace(
    /```(\w+)?\n?([\s\S]*?)```/g,
    (match, lang, code) => {
      const index = codeBlocks.length;
      codeBlocks.push(
        `<pre class="codeBlock"><button class="copyCode" type="button">Copy</button><code>${code.replace(/\n$/, '')}</code></pre>`
      );
      return `\u0000CODE${index}\u0000`;
    }
  );

  out = out.replace(
    /`([^`\n]+)`/g,
    '<code class="inlineCode">$1</code>'
  );

  // headings
  out = out.replace(/^###\s+(.+)$/gm, '<h4>$1</h4>');
  out = out.replace(/^##\s+(.+)$/gm, '<h3>$1</h3>');
  out = out.replace(/^#\s+(.+)$/gm, '<h3>$1</h3>');

  // bold, then italic
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  // links, only http and https
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // lists
  out = out.replace(
    /(?:^|\n)((?:\s*[-*]\s+.+(?:\n|$))+)/g,
    (match, block) => {
      const items = block
        .trim()
        .split(/\n/)
        .map(line => line.replace(/^\s*[-*]\s+/, ''))
        .map(item => `<li>${item}</li>`)
        .join('');
      return `\n<ul>${items}</ul>`;
    }
  );

  out = out.replace(
    /(?:^|\n)((?:\s*\d+\.\s+.+(?:\n|$))+)/g,
    (match, block) => {
      const items = block
        .trim()
        .split(/\n/)
        .map(line => line.replace(/^\s*\d+\.\s+/, ''))
        .map(item => `<li>${item}</li>`)
        .join('');
      return `\n<ol>${items}</ol>`;
    }
  );

  // paragraphs and line breaks
  out = out
    .split(/\n{2,}/)
    .map(block =>
      /^\s*<(h3|h4|ul|ol|pre|\u0000)/.test(block)
        ? block
        : `<p>${block.replace(/\n/g, '<br>')}</p>`
    )
    .join('');

  // put the code blocks back
  out = out.replace(
    /\u0000CODE(\d+)\u0000/g,
    (match, index) => codeBlocks[Number(index)]
  );

  // and leave a place for each card, drawn once it is on the page
  out = out.replace(
    /\u0000CARD(\d+)\u0000/g,
    (match, index) => `<div class="cardSlot" data-card="${index}"></div>`
  );

  requestAnimationFrame(paintCards);

  return out;

}


/*
  Copy buttons on code blocks, wired once for the whole chat.
*/
chat.addEventListener('click', event => {

  const button =
    event.target.closest?.('.copyCode');

  if (!button) return;

  const code =
    button.parentElement.querySelector('code');

  navigator.clipboard
    ?.writeText(code?.textContent || '')
    .then(() => {
      button.textContent = 'Copied';
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 1200);
    })
    .catch(() => {});

});


/*
  Copy, try again and save only show on a real answer: not
  on a "hey" or a "thanks", and not while a reply is still
  being written.
*/
const SMALL_TALK =
  /^(hi|hey|heya|hiya|hello|helo|yo|sup|howdy|morning|evening|afternoon|good (morning|afternoon|evening|night)|gm|thanks|thank you|thx|ty|cheers|ta|ok|okay|k|cool|nice|great|lol|haha|bye|goodbye|see ya|night|how are you|how r u|how's it going|hows it going|what's up|whats up|wassup|you there|are you there)\b/i;

function lastUserText() {
  const rows = chat.querySelectorAll('.messageRow.user .messageBubble');
  return rows.length ? (rows[rows.length - 1].textContent || '').trim() : '';
}

function isSmallTalk(text) {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= 6 && SMALL_TALK.test(text.replace(/[!.?,]+$/g, '').trim());
}

function settleReplyTools(bubble, reply) {
  const wrap = bubble?.closest('.bubbleWrap');
  if (!wrap) return;
  const text = (reply || '').trim();
  const streaming = bubble.classList.contains('streaming') || !text;
  const quiet = streaming || (isSmallTalk(lastUserText()) && text.length < 280);
  wrap.classList.toggle('noTools', quiet);
}

function addTextMessage(
  role,
  content
) {

  emptyState?.remove();


  const row =
    document.createElement(
      'div'
    );

  row.className =
    `messageRow ${role}`;


  const bubble =
    document.createElement(
      'div'
    );

  bubble.className =
    'messageBubble';

  if (role === 'assistant') {

    bubble.classList.add('markdown');

    bubble.dataset.raw = content || '';

    bubble.innerHTML =
      renderMarkdown(content);

  } else {

    bubble.textContent =
      content;

  }


  row.appendChild(
    bubble
  );


  /*
    Copy and retry, as two small icons on the top right
    corner of the reply itself.
  */

  if (role === 'assistant') {

    const wrap =
      document.createElement('div');

    wrap.className = 'bubbleWrap';

    row.replaceChild(wrap, bubble);
    wrap.appendChild(bubble);

    const tools =
      document.createElement('div');

    tools.className = 'replyTools';

    const copy =
      document.createElement('button');

    copy.type = 'button';
    copy.className = 'replyTool';
    copy.title = 'Copy';
    copy.setAttribute('aria-label', 'Copy');
    copy.innerHTML = icon('copy', 14);

    copy.addEventListener('click', () => {

      navigator.clipboard
        ?.writeText(bubble.textContent || '')
        .then(() => {

          copy.innerHTML = icon('check', 14);
          copy.classList.add('done');
          copy.title = 'Copied';

          setTimeout(() => {
            copy.innerHTML = icon('copy', 14);
            copy.classList.remove('done');
            copy.title = 'Copy';
          }, 1200);

        })
        .catch(() => {});

    });

    const retry =
      document.createElement('button');

    retry.type = 'button';
    retry.className = 'replyTool';
    retry.title = 'Try again';
    retry.setAttribute('aria-label', 'Try again');
    retry.innerHTML = icon('refresh', 14);

    retry.addEventListener(
      'click',
      () => retryReply(row)
    );

    const keep =
      document.createElement('button');

    keep.type = 'button';
    keep.className = 'replyTool saveTool';
    keep.innerHTML = icon('bookmark', 14);

    const paintKeep = () => {
      const saved = isSavedComment(bubble.dataset.raw || bubble.textContent || '');
      keep.classList.toggle('saved', saved);
      keep.title = saved ? 'Saved, tap to remove' : 'Save this comment';
      keep.setAttribute('aria-label', keep.title);
      keep.setAttribute('aria-pressed', saved ? 'true' : 'false');
    };

    paintKeep();

    keep.addEventListener('click', async () => {
      keep.disabled = true;
      const answer = bubble.dataset.raw || bubble.textContent || '';
      const wasSaved = isSavedComment(answer);
      await toggleSavedComment(answer, currentChatId);
      keep.disabled = false;
      /* a save means that answer hit the mark */
      if (!wasSaved) {
        let previous = row.previousElementSibling;
        while (previous && !previous.classList.contains('user')) previous = previous.previousElementSibling;
        suggestLesson('saved', (previous?.textContent || '').trim(), answer);
      }
    });

    bubble.paintKeep = paintKeep;

    tools.appendChild(copy);
    tools.appendChild(retry);
    tools.appendChild(keep);

    wrap.appendChild(tools);

    /* no tools on small talk, and none until a streamed reply has finished */
    settleReplyTools(bubble, content);

  }


  chat.appendChild(
    row
  );


  scrollToBottom();


  return row;

}


/* =====================================================
   A PHOTO THE USER SENT
===================================================== */

function addUserImage(chatId, imageUrl, caption) {

  if (!isCurrentChat(chatId)) {
    return;
  }

  emptyState?.remove();

  const row =
    document.createElement('div');

  row.className = 'messageRow user';

  const wrap =
    document.createElement('div');

  wrap.className = 'userImageWrap';

  const img =
    document.createElement('img');

  img.className = 'userImage';

  setImageSource(img, imageUrl);

  img.alt = 'Photo you sent';

  wrap.appendChild(img);

  if (caption) {

    const text =
      document.createElement('div');

    text.className = 'messageBubble';

    text.textContent = caption;

    wrap.appendChild(text);

  }

  row.appendChild(wrap);

  chat.appendChild(row);

  scrollToBottom();

}


/* =====================================================
   ADD IMAGE MESSAGE
===================================================== */

function addImageMessage(
  imageData,
  prompt = '',
  originalImageData = null,
  originalPrompt = '',
  fromUpload = false
) {

  if (isVideoRef(imageData)) {
    addVideoMessage(imageData, prompt);
    return;
  }

  emptyState?.remove();


  const row =
    document.createElement(
      'div'
    );

  row.className =
    'messageRow assistant';


  const wrap =
    document.createElement(
      'div'
    );

  wrap.className =
    'messageImageWrap';


  const image =
    document.createElement(
      'img'
    );

  image.className =
    'generatedImage';

  setImageSource(image, imageData);

  image.alt =
    'Natter AI generated image';


  wrap.appendChild(
    image
  );


  if (prompt) {

    const promptText =
      document.createElement(
        'div'
      );

    promptText.className =
      'imagePrompt';

    promptText.textContent =
      prompt;

    wrap.appendChild(
      promptText
    );

  }


  const actions =
    document.createElement(
      'div'
    );

  actions.className =
    'imageActions';


  const rerenderButton =
    document.createElement(
      'button'
    );

  rerenderButton.className =
    'imageActionButton primary';

  rerenderButton.innerHTML =
    iconLabel('refresh', 'Improve');

  rerenderButton.title =
    'Improve this image while keeping the same subject and identity';

  rerenderButton.dataset.hint =
    'Makes a fresh version of this picture, keeping the ' +
    'same subject but changing the light and the angle.';


  const downloadButton =
    document.createElement(
      'button'
    );

  downloadButton.className =
    'imageActionButton';

  downloadButton.innerHTML =
    iconLabel('download', 'Save');

  downloadButton.dataset.hint =
    'Downloads the picture to your device.';


  /*
    Carry on from this picture: it becomes the attached
    photo, so the next message edits it.
  */

  const continueButton =
    document.createElement('button');

  continueButton.className = 'imageActionButton';

  continueButton.innerHTML =
    iconLabel('pencil', 'Change this', 'Change');

  continueButton.title =
    'Describe a change and Natter edits this picture';

  continueButton.dataset.hint =
    'Attaches this picture so your next message edits it.';

  continueButton.addEventListener('click', async () => {

    const state = imageState.get(stateId);

    try {

      selectedImageData =
        await resolveImage(state?.currentImage || imageData);

    } catch (error) {

      console.error('CHANGE THIS ERROR:', error);

      return;

    }

    photoAction = 'edit';

    photoActionChosen = true;

    selectedImages = [{ data: selectedImageData, name: 'This picture' }];

    paintUploads();

    uploadName.textContent = 'This picture';

    [...photoChoice.children].forEach((item, index) => {
      item.classList.toggle('active', index === 0);
    });

    setImageMode(false);

    messageInput.placeholder =
      'Describe what you want changed...';

    messageInput.focus();

  });


  /*
    Share, where the browser offers it. Phones do, most
    desktops do not, so the button only appears when it
    will actually work.
  */

  const shareButton =
    document.createElement('button');

  shareButton.className = 'imageActionButton';

  shareButton.innerHTML =
    iconLabel('share', 'Share');

  shareButton.dataset.hint =
    'Sends the picture to another app on your device.';

  shareButton.addEventListener('click', async () => {

    try {

      const source =
        await resolveImage(
          imageState.get(stateId)?.currentImage || imageData
        );

      const blob =
        source.startsWith('data:')
          ? dataUrlToBlob(source)
          : await (await fetch(source)).blob();

      const file =
        new File([blob], 'natter.png', {
          type: blob.type || 'image/png'
        });

      if (navigator.canShare?.({ files: [file] })) {

        await navigator.share({
          files: [file],
          text: prompt || 'Made with Natter AI'
        });

        return;

      }

      await navigator.share({
        title: 'Natter AI',
        text: prompt || 'Made with Natter AI',
        url: source.startsWith('http') ? source : location.href
      });

    } catch (error) {

      if (error?.name !== 'AbortError') {
        console.error('SHARE ERROR:', error);
      }

    }

  });


  actions.appendChild(
    rerenderButton
  );

  actions.appendChild(
    continueButton
  );

  if (navigator.share) {
    actions.appendChild(shareButton);
  }

  actions.appendChild(
    downloadButton
  );

  wrap.appendChild(
    actions
  );

  guardImageActions(
    actions
  );

  row.appendChild(
    wrap
  );

  chat.appendChild(
    row
  );


  /*
    Every displayed image gets its own state.

    Most importantly:

    CURRENT IMAGE =
    imageData

    ORIGINAL SOURCE =
    originalImageData || imageData

    Re-render always starts from CURRENT IMAGE.
  */

  const stateId =
    `image-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;


  imageState.set(
    stateId,
    {

      currentImage:
        imageData,

      originalImage:
        originalImageData ||
        imageData,

      prompt:
        prompt || originalPrompt || '',

      originalPrompt:
        originalPrompt ||
        prompt ||
        '',

      fromUpload:
        fromUpload === true

    }
  );


  rerenderButton.addEventListener(
    'click',
    async () => {

      const state =
        imageState.get(
          stateId
        );


      if (
        !state ||
        !state.currentImage
      ) {

        addTextMessage(
          'assistant',
          'I could not find the current image to re-render.'
        );

        return;

      }


      await rerenderImage(
        stateId,
        state,
        rerenderButton
      );

    }
  );


  downloadButton.addEventListener(
    'click',
    () => {

      downloadImage(
        imageData
      );

    }
  );


  scrollToBottom();


  return {
    row,
    stateId
  };

}


/* =====================================================
   IMAGES NEED AN ACCOUNT

   Guests can chat, but image generating and editing
   runs up real cost, so it asks them to sign up.
===================================================== */

function guestImagesBlocked() {

  if (!guestMode) {
    return false;
  }

  showGuestImageNotice();

  return true;

}


function showGuestImageNotice() {

  emptyState?.remove();

  const row =
    document.createElement('div');

  row.className = 'messageRow assistant';

  const bubble =
    document.createElement('div');

  bubble.className = 'messageBubble guestPrompt';

  const text =
    document.createElement('div');

  text.textContent =
    'Creating and editing images needs an account. ' +
    'Create one and you can generate images, and your ' +
    'chats will follow you to any device.';

  const button =
    document.createElement('button');

  button.className = 'guestPromptButton';

  button.textContent = 'Create an account';

  button.addEventListener(
    'click',
    () => {

      stopGuestMode();

      signupMode = true;

      updateAuthMode();

      showAuth();

    }
  );

  bubble.appendChild(text);
  bubble.appendChild(button);

  row.appendChild(bubble);

  chat.appendChild(row);

  scrollToBottom();

}


/* =====================================================
   RENDER INTO A PARTICULAR CHAT

   A job can finish while the user is reading another
   chat. The message is always saved, and only drawn
   if that chat is the one on screen.
===================================================== */

function addTextMessageTo(chatId, role, content) {

  if (!isCurrentChat(chatId)) {
    return;
  }

  addTextMessage(role, content);

}

function addImageMessageTo(
  chatId,
  imageData,
  prompt,
  originalImageData,
  originalPrompt,
  fromUpload = false
) {

  if (!isCurrentChat(chatId)) {
    return;
  }

  addImageMessage(
    imageData,
    prompt,
    originalImageData,
    originalPrompt,
    fromUpload
  );

}


/* =====================================================
   VIDEO

   Admins only while it is tested. The server starts a
   clip with Google Veo, then we ask after it every few
   seconds. The finished clip is sealed and stored exactly
   like a picture, so the chat keeps only a reference.
===================================================== */

function isVideoRef(ref) {

  return typeof ref === 'string' &&
    (ref.startsWith('encimg:video/') ||
     ref.startsWith('data:video/') ||
     /\.mp4(\?|#|$)/i.test(ref));

}


function addVideoMessage(ref, prompt = '') {

  emptyState?.remove();

  const row = document.createElement('div');
  row.className = 'messageRow assistant';

  const wrap = document.createElement('div');
  wrap.className = 'messageImageWrap';

  const video = document.createElement('video');
  video.className = 'generatedVideo';
  video.controls = true;
  video.playsInline = true;
  video.loop = true;
  video.preload = 'metadata';
  video.setAttribute('playsinline', '');

  if (ref.startsWith('data:') || imageCache.has(ref)) {

    video.src = imageCache.get(ref) || ref;

  } else {

    resolveImage(ref)
      .then(url => { video.src = url; })
      .catch(error => {
        console.error('VIDEO OPEN ERROR:', error);
        const note = document.createElement('div');
        note.className = 'imagePrompt';
        note.textContent = error.message || 'This video could not be opened.';
        wrap.appendChild(note);
      });

  }

  wrap.appendChild(video);

  if (prompt) {
    const promptText = document.createElement('div');
    promptText.className = 'imagePrompt';
    promptText.textContent = prompt;
    wrap.appendChild(promptText);
  }

  const actions = document.createElement('div');
  actions.className = 'imageActions';

  const saveButton = document.createElement('button');
  saveButton.className = 'imageActionButton';
  saveButton.type = 'button';
  saveButton.innerHTML = iconLabel('download', 'Save');
  saveButton.title = 'Download the video';

  saveButton.addEventListener('click', async () => {

    try {

      const url = await resolveImage(ref);

      const link = document.createElement('a');
      link.href = url;
      link.download = `natter-video-${Date.now()}.mp4`;
      document.body.appendChild(link);
      link.click();
      link.remove();

    } catch (error) {
      console.error('VIDEO SAVE ERROR:', error);
    }

  });

  actions.appendChild(saveButton);
  wrap.appendChild(actions);

  guardImageActions(actions);

  row.appendChild(wrap);
  chat.appendChild(row);

  scrollToBottom();

}


const pause = ms => new Promise(resolve => setTimeout(resolve, ms));


async function generateVideo(prompt, requestChatId, image = null) {

  if (!prompt) return;

  const jobId =
    startJob(requestChatId, 'Creating your video, this can take a minute or two...');

  try {

    const started =
      await fetch(`${API_BASE}/api/video`, {
        method: 'POST',
        headers: await apiHeaders(),
        body: JSON.stringify({
          prompt,
          shape: imageShape === 'portrait' ? 'portrait' : 'landscape',
          image
        })
      });

    const job = await started.json().catch(() => ({}));

    if (started.status === 402 || job?.needsCredit) {
      await refreshAccount();
      openPaywall('empty');
    }

    if (!started.ok || !job.id) {
      throw new Error(job.error || 'The video could not be started.');
    }

    /* up to ten minutes, checking every five seconds */
    let finished = null;

    for (let tries = 0; tries < 120; tries += 1) {

      await pause(5000);

      let response;

      try {
        response =
          await fetch(
            `${API_BASE}/api/video/status?id=${encodeURIComponent(job.id)}`,
            { headers: await apiHeaders() }
          );
      } catch {
        continue; // a dropped connection, just ask again
      }

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || 'Could not check on the video.');
      }

      if (data.done) {
        if (data.error) throw new Error(data.error);
        finished = data.video;
        break;
      }

    }

    if (!finished) {
      throw new Error('The video took too long. Try again in a moment.');
    }

    /* the balance may have gone down */
    refreshAccount();

    const storedRef = await storeImage(finished);

    /* never keep a whole clip inside the chat history itself */
    const kept =
      typeof storedRef === 'string' && !storedRef.startsWith('data:')
        ? storedRef
        : null;

    if (isCurrentChat(requestChatId)) {
      addVideoMessage(kept || finished, prompt);
    }

    await saveMessage(
      'assistant',
      kept ? prompt : `${prompt}\n\n(This video could not be saved to your chat, so use Save to keep it.)`,
      kept,
      requestChatId
    );

  } catch (error) {

    console.error('GENERATE VIDEO ERROR:', error);

    const failure = `Video creation failed:\n${friendlyMediaError(error.message, 'video')}`;

    addTextMessageTo(requestChatId, 'assistant', failure);

    await saveMessage('assistant', failure, null, requestChatId);

    offerFittingVersion(requestChatId, prompt, 'video', error.message);

  } finally {

    endJob(jobId);

  }

}




function setVideoMode(enabled) {

  videoMode = Boolean(enabled);

  if (videoMode && imageMode) {
    setImageMode(false);
  }

  shapeRow.classList.toggle('videoShapes', videoMode);
  shapeRow.classList.toggle('show', videoMode || imageMode);

  /* square is not a video shape */
  if (videoMode && imageShape === 'square') {
    shapeRow.querySelector('[data-shape="landscape"]')?.click();
  }

  videoButton?.classList.toggle('imageModeActive', videoMode);
  videoButton?.setAttribute('aria-pressed', videoMode ? 'true' : 'false');

  if (videoButton) {
    videoButton.title =
      videoMode ? 'Video mode on, press again to turn off' : 'Create a short video from your description';
  }

  messageInput.placeholder =
    videoMode
      ? (selectedImageData
          ? 'Describe how this photo should come to life...'
          : 'Describe the video you want me to create...') +
        (account?.videoCost ? ` (uses ${account.videoCost} images)` : '')
      : (selectedImageData ? 'Ask about it, or say what to change...' : 'Message Natter...');

}


const videoButton = document.getElementById('videoButton');

videoButton?.addEventListener('click', () => {

  setVideoMode(!videoMode);

  messageInput.focus();

});


/*
  The image and video services turn some requests down.
  Say so plainly instead of showing their raw error, with
  its request numbers and codes.
*/
function friendlyMediaError(message, what) {

  const text = String(message || '');

  if (/safety system|safety_violations|content policy|moderation|blocked by the safety|raiMediaFiltered/i.test(text)) {
    return `The ${what} service turned that one down under its safety rules, so nothing was made and nothing was charged. Try describing it a different way.`;
  }

  if (/rate limit|429|too many/i.test(text)) {
    return `The ${what} service is busy right now. Give it a minute and try again.`;
  }

  return text;

}


/* =====================================================
   GENERATE IMAGE
===================================================== */

async function generateImage(
  prompt,
  requestChatId
) {

  if (!prompt) {
    return;
  }


  const jobId =
    startJob(
      requestChatId,
      'Creating your image...'
    );


  try {

    const response =
      await fetch(
        `${API_BASE}/api/image`,
        {

          method:
            'POST',

          headers:
            await apiHeaders(),

          body:
            JSON.stringify({
              prompt,
              shape: imageShape
            })

        }
      );


    const data =
      await response.json();


    if (response.status === 402 || data?.needsCredit) {

      await refreshAccount();

      openPaywall('empty');

      throw new Error(
        data?.error ||
        'You are out of images. Top up to carry on.'
      );

    }

    if (!response.ok) {

      throw new Error(
        data?.details ||
        data?.error ||
        'Image generation failed.'
      );

    }

    if (typeof data.creditsLeft === 'number') {
      account.credits = data.creditsLeft;
      drawCredits();
    }


    if (!data?.image) {

      throw new Error(
        'No image was returned.'
      );

    }


    /*
      IMPORTANT:

      The generated image becomes the
      current source for the next
      re-render.
    */

    /*
      Draw straight away from what came back, then keep
      only the stored address in the chat history.
    */

    const storedUrl =
      await storeImage(data.image);


    addImageMessageTo(
      requestChatId,
      data.image,
      prompt,
      storedUrl,
      prompt
    );


    await saveMessage(
      'assistant',
      prompt,
      storedUrl,
      requestChatId
    );


  } catch (error) {

    console.error(
      'GENERATE IMAGE ERROR:',
      error
    );


    const failure =
      `Image generation failed:\n${friendlyMediaError(error.message, 'image')}`;

    addTextMessageTo(
      requestChatId,
      'assistant',
      failure
    );

    await saveMessage(
      'assistant',
      failure,
      null,
      requestChatId
    );

    offerFittingVersion(requestChatId, prompt, 'image', error.message);

  } finally {

    endJob(jobId);

  }

}


/* =====================================================
   EDIT IMAGE
===================================================== */

async function editImage(
  image,
  prompt,
  requestChatId,
  regenerate = false,
  caption = null,
  fromUpload = false,

  /* the other photos, when more than one was uploaded */
  extraImages = null
) {

  if (!image) {

    throw new Error(
      'No image supplied.'
    );

  }


  const jobId =
    startJob(
      requestChatId,
      regenerate
        ? 'Improving your image...'
        : 'Editing your image...'
    );


  try {

    /*
      The server cannot open a sealed picture, so it gets
      the opened one.
    */
    image =
      await resolveImage(image);

    if (Array.isArray(extraImages) && extraImages.length) {
      extraImages = await Promise.all(extraImages.map(one => resolveImage(one)));
    }

    const response =
      await fetch(
        `${API_BASE}/api/image/edit`,
        {

          method:
            'POST',

          headers:
            await apiHeaders(),

          body:
            JSON.stringify({

              prompt,

              image,

              images: extraImages,

              regenerate,

              shape: imageShape,

              /*
                Tells the server this is a real photograph,
                which is when likeness is locked down hard.
              */
              fromUpload

            })

        }
      );


    const data =
      await response.json();


    if (response.status === 402 || data?.needsCredit) {

      await refreshAccount();

      openPaywall('empty');

      throw new Error(
        data?.error ||
        'You are out of images. Top up to carry on.'
      );

    }

    if (typeof data.creditsLeft === 'number') {
      account.credits = data.creditsLeft;
      drawCredits();
    }

    if (!response.ok) {

      throw new Error(
        data?.details ||
        data?.error ||
        'Image edit failed.'
      );

    }


    if (!data?.image) {

      throw new Error(
        'No edited image was returned.'
      );

    }


    /*
      CRITICAL:

      The newly edited image becomes
      the source for the NEXT render.

      We do NOT send the original
      prompt back to /api/image.
    */

    /*
      What the user sees under the image is their own
      request, never the instructions sent to the model.
    */

    const shownPrompt =
      caption || prompt;


    const storedUrl =
      await storeImage(data.image);


    addImageMessageTo(
      requestChatId,
      data.image,
      shownPrompt,
      storedUrl,
      shownPrompt,
      fromUpload
    );


    await saveMessage(
      'assistant',
      shownPrompt,
      storedUrl,
      requestChatId
    );


    return data.image;


  } finally {

    endJob(jobId);

  }

}


/* =====================================================
   RE-RENDER / IMPROVE
===================================================== */

async function rerenderImage(
  stateId,
  state,
  button
) {

  if (!state?.currentImage) {

    return;

  }


  if (guestImagesBlocked()) {

    return;

  }


  /*
    The chat this image belongs to, captured before
    anything asynchronous happens, so the result lands
    in the right place even if the user moves on.
  */

  const requestChatId = currentChatId;


  /*
    The current image is the actual source.

    We deliberately do NOT call /api/image.

    We call /api/image/edit so the AI edits
    the existing image.
  */

  const currentImage =
    state.currentImage;


  const originalPrompt =
    state.originalPrompt ||
    state.prompt ||
    'Improve this image.';


  /*
    Every press must move the light, the background and the
    camera. The list only decides which direction, so two
    presses never land in the same place.
  */

  const lighting = [
    'hard low sun from the side, long shadows',
    'soft overcast light, gentle shadows',
    'warm golden hour light from behind the subject',
    'cool blue light with a bright rim on one edge',
    'dim moody light with one strong source'
  ];

  const cameras = [
    'a low angle looking up, close in',
    'a high angle looking down, further back',
    'eye level, tight crop on the subject',
    'a wide shot with the subject off centre',
    'a three quarter view from the side'
  ];

  /*
    Every option names a real place. An empty floor is
    never one of them: a blank grey backdrop adds nothing
    to the picture.
  */
  const backgrounds = [
    'a real location that suits the subject, with depth and things happening behind them',
    'a different real place from the supplied image, still suiting the subject',
    'the same kind of place at a different time of day, with its own light and atmosphere',
    'a wider view of a real setting, showing where the subject actually is',
    'a real setting with foreground and background layers, the background softly out of focus'
  ];

  improveSequence++;

  state.improveCount =
    (state.improveCount || 0) + 1;

  const pickFrom = list =>
    list[(improveSequence - 1) % list.length];

  const improvementPrompt = `
Create a new version of the supplied image.
This is attempt ${state.improveCount}.

ORIGINAL REQUEST:

${originalPrompt}

KEEP THE SUBJECT EXACTLY:

The subject of the supplied image stays the same.
Same subject, same character, same identity, same
species, same clothing or markings, same defining
features. If a person is present, keep their face,
facial structure, skin tone and hair.

The subject must be recognisably the same in the
new image.

CHANGE ALL THREE OF THESE:

1. LIGHTING: ${pickFrom(lighting)}.
2. CAMERA: ${pickFrom(cameras)}.
3. BACKGROUND: ${pickFrom(backgrounds)}.

Each of the three must visibly change. A version
that keeps the same lighting, the same angle and
the same background is a failed result.

ALSO IMPROVE:

realism, detail, texture, shadows, clarity and
overall polish.

DO NOT:

Do not swap the subject for a different one.
Do not reproduce the supplied image.
Do not drop anything the original request asked for.

Do not place the subject on a blank studio floor, plain
tarmac, seamless backdrop or empty grey ground. There must
be a real environment around them, unless the original
request specifically asked for a plain background.
`;


  button.disabled =
    true;

  button.classList.add('busy');

  button.innerHTML =
    iconLabel('refresh', 'Improving...', 'Working');


  try {

    const newImage =
      await editImage(
        currentImage,
        improvementPrompt,
        requestChatId,
        true,
        originalPrompt,
        state.fromUpload === true
      );


    if (!newImage) {
      return;
    }


    /*
      Update this image's state.

      This is what makes:

      Image 1
        ↓
      Image 2
        ↓
      Image 3
        ↓
      Image 4

      work correctly.
    */

    state.currentImage =
      newImage;

    state.prompt =
      originalPrompt;


    imageState.set(
      stateId,
      state
    );


  } catch (error) {

    console.error(
      'RENDER ERROR:',
      error
    );


    addTextMessageTo(
      requestChatId,
      'assistant',
      `Could not improve the image:\n${friendlyMediaError(error.message, 'image')}`
    );

  } finally {

    button.disabled =
      false;

    button.classList.remove('busy');

    button.innerHTML =
      iconLabel('refresh', 'Improve');

  }

}


stopButton.addEventListener('click', () => {

  replyController?.abort();

  stopButton.classList.remove('show');

});


/* =====================================================
   ICONS

   Plain line icons, drawn inline. No emoji, so they take
   the colour of whatever button they sit in.
===================================================== */

const ICONS = {
  refresh:
    '<path d="M21 12a9 9 0 1 1-2.6-6.4"></path><polyline points="21 3 21 9 15 9"></polyline>',
  pencil:
    '<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>',
  share:
    '<circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.6" y1="10.5" x2="15.4" y2="6.5"></line><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"></line>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>',
  copy:
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>',
  check:
    '<polyline points="20 6 9 17 4 12"></polyline>',
  bookmark:
    '<path d="M19 21l-7-4.5L5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>',
  trash:
    '<path d="M3 6h18"></path><path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6"></path><path d="M5.5 6l1 13.2A2 2 0 0 0 8.5 21h7a2 2 0 0 0 2-1.8L18.5 6"></path><path d="M10 11v6M14 11v6"></path>'
};

function icon(name, size = 15) {

  return (
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    'fill="none" stroke="currentColor" stroke-width="2" ' +
    `stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`
  );

}

/*
  On a phone these buttons sit shoulder to shoulder, so the
  first tap says what the button does and the second one
  runs it. The hint clears itself, with a draining bar so
  nothing vanishes silently.
*/

const CONFIRM_TAP_WIDTH = 760;

function wantsConfirmTap() {

  return (
    window.matchMedia?.(
      `(max-width: ${CONFIRM_TAP_WIDTH}px)`
    )?.matches === true
  );

}


function guardImageActions(actions) {

  let armed = null;
  let hint = null;
  let timer = null;

  function disarm() {

    clearTimeout(timer);
    timer = null;

    armed?.classList.remove('armed');
    armed = null;

    hint?.remove();
    hint = null;

  }

  function arm(button) {

    disarm();

    armed = button;

    button.classList.add('armed');

    hint =
      document.createElement('div');

    hint.className = 'actionHint';

    const name =
      document.createElement('strong');

    name.textContent =
      (button.querySelector('.actionLabel.full')
        ?.textContent || 'This button').trim();

    const what =
      document.createElement('span');

    what.textContent =
      ` ${button.dataset.hint || ''}`;

    const go =
      document.createElement('span');

    go.className = 'actionHintGo';

    go.textContent =
      'Tap again to continue.';

    const bar =
      document.createElement('span');

    bar.className = 'actionHintBar';

    hint.appendChild(name);
    hint.appendChild(what);
    hint.appendChild(go);
    hint.appendChild(bar);

    actions.insertAdjacentElement(
      'afterend',
      hint
    );

    timer =
      setTimeout(disarm, 4200);

  }


  /*
    Capture runs before the button's own handler, so an
    unarmed tap never reaches it.
  */

  actions.addEventListener('click', event => {

    const button =
      event.target.closest?.('.imageActionButton');

    if (!button || button.disabled) return;

    if (!wantsConfirmTap()) {
      disarm();
      return;
    }

    if (button === armed) {
      disarm();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    arm(button);

  }, true);

}


function iconLabel(name, label, short) {

  return (
    `${icon(name)}` +
    `<span class="actionLabel full">${label}</span>` +
    `<span class="actionLabel short">${short || label}</span>`
  );

}


/* =====================================================
   END TO END ENCRYPTION

   Everything you type is encrypted in this browser before
   it is sent anywhere. The database only ever holds
   ciphertext, and the key is derived from your password,
   which we never see.

   The shape of it:

     password + salt  ->  KEK   (PBKDF2, 310k rounds)
     KEK              wraps     DEK   (random, AES-GCM 256)
     DEK              encrypts  your chats

   The wrapped DEK is kept on your profile row. Without
   your password it is a lump of noise, so nobody holding
   the database, us included, can read a word of it.

   The honest limit: to answer you, your message still has
   to reach the model in the clear. This protects what is
   STORED, not the conversation in flight.
===================================================== */

const ENC_PREFIX = 'enc1:';

const DEK_KEY = 'nastivee_dek';

const PBKDF2_ROUNDS = 310000;

let dataKey = null;

let vaultLocked = false;


function cryptoReady() {
  return Boolean(window.crypto?.subtle);
}


function toBase64(bytes) {

  let binary = '';

  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary);

}


function fromBase64(text) {

  const binary = atob(text);

  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;

}


async function deriveKek(password, salt) {

  const material =
    await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ROUNDS,
      hash: 'SHA-256'
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

}


async function importDataKey(bytes) {

  return crypto.subtle.importKey(
    'raw',
    bytes,
    'AES-GCM',
    true,
    ['encrypt', 'decrypt']
  );

}


/*
  Encrypting a single field. Empty stays empty, so a blank
  message does not turn into a blob.
*/
async function encField(text) {

  if (!dataKey || !text) {
    return text || '';
  }

  try {

    const iv =
      crypto.getRandomValues(new Uint8Array(12));

    const cipher =
      new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          dataKey,
          new TextEncoder().encode(text)
        )
      );

    return (
      ENC_PREFIX +
      toBase64(iv) + ':' +
      toBase64(cipher)
    );

  } catch (error) {

    console.error('ENCRYPT ERROR:', error);

    return text;

  }

}


/*
  Reading a field back. Anything written before this
  existed is plain text and comes through untouched.
*/
/*
  What a message that cannot be opened shows as. It is
  only ever for display: anything marked locked is kept out
  of what is sent to the AI.
*/
const LOCKED_NOTE =
  'This message could not be unlocked on this device.';

/*
  Keys this device used before its current one. Kept only
  so that anything written under them can still be read,
  and moved over to the current key, then dropped.
*/
let olderKeys = [];


async function tryDecrypt(key, value) {

  const [, ivPart, cipherPart] =
    value.split(':');

  const plain =
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(ivPart) },
      key,
      fromBase64(cipherPart)
    );

  return new TextDecoder().decode(plain);

}


/*
  { text, locked, stale }. Stale means it opened with an
  older key and should be re-sealed under the current one.
*/
async function decFieldResult(value) {

  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) {
    return { text: value, locked: false, stale: false };
  }

  if (dataKey) {

    try {
      return { text: await tryDecrypt(dataKey, value), locked: false, stale: false };
    } catch {}

  }

  for (const key of olderKeys) {

    try {
      return { text: await tryDecrypt(key, value), locked: false, stale: true };
    } catch {}

  }

  return { text: LOCKED_NOTE, locked: true, stale: false };

}


async function decField(value) {

  return (await decFieldResult(value)).text;

}


/*
  The same thing for raw bytes, used for images. The IV
  rides in the first 12 bytes of what is stored.
*/
async function encBytes(plain) {

  const iv =
    crypto.getRandomValues(new Uint8Array(12));

  const sealed =
    new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        dataKey,
        plain
      )
    );

  const out =
    new Uint8Array(iv.length + sealed.length);

  out.set(iv, 0);
  out.set(sealed, iv.length);

  return out;

}


async function decBytes(stored) {

  /* the current key first, then any older key this device kept */
  let lastError = null;

  for (const key of [dataKey, ...olderKeys].filter(Boolean)) {

    try {

      const plain =
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: stored.slice(0, 12) },
          key,
          stored.slice(12)
        );

      return new Uint8Array(plain);

    } catch (error) {
      lastError = error;
    }

  }

  throw lastError || new Error('No key to open this picture.');

}


async function decRows(rows, fields) {

  return Promise.all(
    (rows || []).map(async row => {

      const copy = { ...row };

      for (const field of fields) {

        const result =
          await decFieldResult(row[field]);

        copy[field] = result.text;

        if (result.locked) copy.__locked = true;
        if (result.stale) copy.__stale = true;

      }

      return copy;

    })
  );

}


/*
  Rows that only opened with an older key are written
  again under the current one, quietly, so every device
  can read them from now on.
*/
function resealStale(table, rows, fields) {

  if (!dataKey || !currentUser) return;

  (rows || [])
    .filter(row => row.__stale && row.id != null)
    .forEach(async row => {

      try {

        const update = {};

        for (const field of fields) {
          update[field] = await encField(row[field]);
        }

        await supabaseClient
          .from(table)
          .update(update)
          .eq('id', row.id);

      } catch (error) {
        console.warn('RESEAL FAILED:', error);
      }

    });

}


/*
  When this device held a different key from the one on
  the account, keep it aside so messages written under it
  can still be opened and moved over to the right key.
*/
function olderKeyName() {
  return `${DEK_KEY}_${currentUser.id}_old`;
}

async function keepOlderKey(previous, current) {

  if (!previous || !current || !currentUser) return;

  try {

    const before = toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', previous)));
    const now = toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', current)));

    if (before === now) return;

    const saved = JSON.parse(localStorage.getItem(olderKeyName()) || '[]');

    if (!saved.includes(before)) saved.push(before);

    localStorage.setItem(olderKeyName(), JSON.stringify(saved.slice(-5)));

    olderKeys.push(previous);

  } catch {}

}

async function loadOlderKeys() {

  olderKeys = [];

  try {

    const saved = JSON.parse(localStorage.getItem(olderKeyName()) || '[]');

    for (const item of saved) {
      olderKeys.push(await importDataKey(fromBase64(item)));
    }

  } catch {}

}

function forgetOlderKey() {

  try {
    if (currentUser) localStorage.removeItem(olderKeyName());
  } catch {}

}


/*
  Remembering the key on THIS device only, so a reload
  does not ask for the password again. It never leaves
  the browser.
*/
async function rememberDataKey() {

  try {

    const raw =
      new Uint8Array(
        await crypto.subtle.exportKey('raw', dataKey)
      );

    localStorage.setItem(
      `${DEK_KEY}_${currentUser.id}`,
      toBase64(raw)
    );

  } catch {}

}


/* The key this device has saved, without using it yet */
async function storedDataKey() {

  try {

    const stored =
      localStorage.getItem(`${DEK_KEY}_${currentUser.id}`);

    return stored ? await importDataKey(fromBase64(stored)) : null;

  } catch {

    return null;

  }

}


/* Which lock on the account this device's key came from */
function noteLock(wrapped) {

  try {
    if (currentUser && wrapped) {
      localStorage.setItem(`${DEK_KEY}_${currentUser.id}_lock`, wrapped);
    }
  } catch {}

}


/*
  Is the key saved on this device still the account's key?
  A device can hold one that was replaced elsewhere, and
  then everything it writes is unreadable anywhere else.
  Each device notes which lock its key came from. If the
  lock on the account has changed since (a reset, or a
  password change on another device), ask for the password
  once. A device from before this check asks once too,
  unless there is nothing encrypted yet. A network blip
  never locks anyone out.
*/
async function keyStillCurrent(key) {

  try {

    const { data, error } =
      await supabaseClient
        .from('profiles')
        .select('key_wrapped')
        .eq('id', currentUser.id)
        .maybeSingle();

    if (error) return true;

    if (!data?.key_wrapped) return true;

    let noted = null;

    try {
      noted = localStorage.getItem(`${DEK_KEY}_${currentUser.id}_lock`);
    } catch {}

    if (noted) return noted === data.key_wrapped;

    const { data: recent, error: recentError } =
      await supabaseClient
        .from('messages')
        .select('id')
        .like('content', `${ENC_PREFIX}%`)
        .limit(1);

    if (recentError) return true;

    /* nothing written yet, so nothing can be out of step */
    if (!recent?.length) {
      noteLock(data.key_wrapped);
      return true;
    }

    /*
      Otherwise we cannot tell from here alone (a device
      whose key went stale may have written everything
      recent itself), so the password settles it, once.
    */
    return false;

  } catch {

    return true;

  }

}


async function recallDataKey() {

  try {

    const key = await storedDataKey();

    if (!key) return false;

    /* Out of date: ask for the password, and keep this one to rescue what it wrote */
    if (!(await keyStillCurrent(key))) {
      console.warn('SAVED KEY IS OUT OF DATE, ASKING FOR PASSWORD');
      return false;
    }

    dataKey = key;

    await loadOlderKeys();

    return true;

  } catch {

    return false;

  }

}


function forgetDataKey() {

  try {

    if (currentUser) {
      localStorage.removeItem(`${DEK_KEY}_${currentUser.id}`);
      localStorage.removeItem(`${DEK_KEY}_${currentUser.id}_lock`);
      localStorage.removeItem(`${DEK_KEY}_${currentUser.id}_old`);
    }

  } catch {}

  dataKey = null;

  olderKeys = [];

}


/*
  Is there anything to unlock? An account made before
  encryption existed has no vault, and asking such a user
  for a password would strand them on a screen that cannot
  help them.

  Anything that goes wrong here answers no, because the
  worst case is carrying on unencrypted, and the worst case
  of answering yes is locking somebody out of their own
  account.
*/
async function vaultExists() {

  try {

    const { data, error } =
      await supabaseClient
        .from('profiles')
        .select('key_wrapped')
        .eq('id', currentUser.id)
        .maybeSingle();

    if (error) {

      console.warn('VAULT CHECK FAILED:', error.message);

      return false;

    }

    return Boolean(data?.key_wrapped);

  } catch (error) {

    console.warn('VAULT CHECK EXCEPTION:', error);

    return false;

  }

}


/*
  Opens the vault with a password. Makes one on the first
  visit, opens it on every visit after.

  Returns 'opened', 'created' or 'wrong'.
*/
async function openVault(password) {

  if (!cryptoReady() || !currentUser) {
    return 'wrong';
  }

  const { data, error: readError } =
    await supabaseClient
      .from('profiles')
      .select('key_salt, key_iv, key_wrapped')
      .eq('id', currentUser.id)
      .maybeSingle();

  /*
    A failed read is not the same as no vault. Treating it
    as one used to make a brand new key over the top of the
    real one, locking away everything written before.
  */
  if (readError) {
    throw new Error('Could not reach your account. Try again.');
  }

  /* First time here: make a key and lock it away */
  if (!data?.key_wrapped) {

    const made =
      await createVault(password);

    /* someone else made one a moment ago, so open that */
    if (made === 'exists') {
      return openVault(password);
    }

    return 'created';

  }

  try {

    const kek =
      await deriveKek(
        password,
        fromBase64(data.key_salt)
      );

    const raw =
      new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: fromBase64(data.key_iv)
          },
          kek,
          fromBase64(data.key_wrapped)
        )
      );

    const opened = await importDataKey(raw);

    /* the key this device had, if it was a different one */
    await loadOlderKeys();
    await keepOlderKey(dataKey || (await storedDataKey()), opened);

    noteLock(data.key_wrapped);

    dataKey = opened;

    vaultLocked = false;

    await rememberDataKey();

    return 'opened';

  } catch {

    return 'wrong';

  }

}


async function createVault(password, { replace = false } = {}) {

  const salt =
    crypto.getRandomValues(new Uint8Array(16));

  const iv =
    crypto.getRandomValues(new Uint8Array(12));

  const kek =
    await deriveKek(password, salt);

  /*
    If this device already holds a key that never made it
    to the account (older saves could fail quietly), lock
    that one away rather than making a new one, so nothing
    it already sealed is lost. A deliberate reset always
    starts fresh.
  */
  const existing =
    replace ? null : (dataKey || (await storedDataKey()));

  dataKey =
    existing ||
    await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

  const raw =
    new Uint8Array(
      await crypto.subtle.exportKey('raw', dataKey)
    );

  const wrapped =
    new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        kek,
        raw
      )
    );

  const lock = {
    key_salt: toBase64(salt),
    key_iv: toBase64(iv),
    key_wrapped: toBase64(wrapped)
  };

  /*
    A deliberate reset replaces the key outright, and the
    old recovery code goes with it, since it only opens
    the old key.
  */
  if (replace) {

    const { data: swapped, error: swapError } =
      await supabaseClient
        .from('profiles')
        .update({
          ...lock,
          key_recovery_salt: null,
          key_recovery_iv: null,
          key_recovery_wrapped: null
        })
        .eq('id', currentUser.id)
        .select('id');

    if (swapError || !swapped?.length) {
      dataKey = null;
      throw new Error('Could not save your key. Try again.');
    }

    olderKeys = [];
    forgetOlderKey();
    noteLock(lock.key_wrapped);
    vaultLocked = false;
    await rememberDataKey();
    return 'created';

  }

  /*
    Only ever fill an empty slot. The update touches a row
    only where there is no key yet; if there is no row at
    all, one is inserted. Neither can overwrite a key that
    already exists.
  */
  const { data: filled, error: updateError } =
    await supabaseClient
      .from('profiles')
      .update(lock)
      .eq('id', currentUser.id)
      .is('key_wrapped', null)
      .select('id');

  if (updateError) {
    dataKey = null;
    throw new Error('Could not save your key. Try again.');
  }

  if (!filled?.length) {

    const { data: existing } =
      await supabaseClient
        .from('profiles')
        .select('key_wrapped')
        .eq('id', currentUser.id)
        .maybeSingle();

    if (existing?.key_wrapped) {
      dataKey = null;
      return 'exists';
    }

    const { error: insertError } =
      await supabaseClient
        .from('profiles')
        .insert({ id: currentUser.id, ...lock });

    if (insertError) {
      dataKey = null;
      throw new Error('Could not save your key. Try again.');
    }

  }

  noteLock(lock.key_wrapped);

  vaultLocked = false;

  await rememberDataKey();

  return 'created';

}


/* =====================================================
   RE-LOCKING THE KEY

   The data key never changes, only what it is locked
   with. So a new password, or a recovery code, is just a
   second lock on the same key, and nothing that was
   written under it is lost.
===================================================== */

/* No 0/O, 1/I/L: a code people copy by hand */
const RECOVERY_ALPHABET =
  'ABCDEFGHJKMNPQRSTUVWXYZ23456789';


function makeRecoveryCode() {

  /*
    Throw away bytes that would favour the first few letters,
    so every character is exactly as likely as every other.
  */
  const size = RECOVERY_ALPHABET.length;

  const ceiling = 256 - (256 % size);

  const chars = [];

  while (chars.length < 20) {

    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {

      if (byte < ceiling && chars.length < 20) {
        chars.push(RECOVERY_ALPHABET[byte % size]);
      }

    }

  }

  return [0, 5, 10, 15]
    .map(at => chars.slice(at, at + 5).join(''))
    .join('-');

}


/* What people type is forgiving, what we derive from is exact */
function normaliseRecoveryCode(code) {

  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

}


/*
  Locks the data key under a secret. Returns the three
  columns to store, and never the secret or the key.
*/
async function wrapDataKey(secret) {

  const salt =
    crypto.getRandomValues(new Uint8Array(16));

  const iv =
    crypto.getRandomValues(new Uint8Array(12));

  const kek =
    await deriveKek(secret, salt);

  const raw =
    new Uint8Array(
      await crypto.subtle.exportKey('raw', dataKey)
    );

  const wrapped =
    new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        kek,
        raw
      )
    );

  return {
    salt: toBase64(salt),
    iv: toBase64(iv),
    wrapped: toBase64(wrapped)
  };

}


async function unwrapDataKey(secret, salt, iv, wrapped) {

  const kek =
    await deriveKek(secret, fromBase64(salt));

  const raw =
    new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(iv) },
        kek,
        fromBase64(wrapped)
      )
    );

  return importDataKey(raw);

}


/*
  Puts the password lock on the key. Hands back what was
  there before, so a caller can put it back if the rest of
  a password change fails.
*/
async function relockWithPassword(password) {

  const { data: before } =
    await supabaseClient
      .from('profiles')
      .select('key_salt, key_iv, key_wrapped')
      .eq('id', currentUser.id)
      .maybeSingle();

  const lock =
    await wrapDataKey(password);

  const { error } =
    await saveProfile({
      key_salt: lock.salt,
      key_iv: lock.iv,
      key_wrapped: lock.wrapped
    });

  if (error) throw error;

  noteLock(lock.wrapped);

  return before || null;

}


async function restorePasswordLock(before) {

  if (!before?.key_wrapped) return;

  await saveProfile({
    key_salt: before.key_salt,
    key_iv: before.key_iv,
    key_wrapped: before.key_wrapped
  });

  noteLock(before.key_wrapped);

}


/*
  Makes a fresh recovery code and locks the key under it.
  Any earlier code stops working the moment this saves.
*/
async function createRecoveryCode() {

  if (!dataKey) {
    throw new Error('Unlock your chats first.');
  }

  const code =
    makeRecoveryCode();

  const lock =
    await wrapDataKey(normaliseRecoveryCode(code));

  const { error } =
    await saveProfile({
      key_recovery_salt: lock.salt,
      key_recovery_iv: lock.iv,
      key_recovery_wrapped: lock.wrapped
    });

  if (error) throw error;

  return code;

}


async function hasRecoveryCode() {

  try {

    const { data } =
      await supabaseClient
        .from('profiles')
        .select('key_recovery_wrapped')
        .eq('id', currentUser.id)
        .maybeSingle();

    return Boolean(data?.key_recovery_wrapped);

  } catch {

    return false;

  }

}


/*
  Opens the vault with a recovery code, then puts the new
  password lock on it so next time the password is enough.
*/
async function openWithRecoveryCode(code, newPassword) {

  const { data } =
    await supabaseClient
      .from('profiles')
      .select('key_recovery_salt, key_recovery_iv, key_recovery_wrapped')
      .eq('id', currentUser.id)
      .maybeSingle();

  if (!data?.key_recovery_wrapped) {
    return 'none';
  }

  try {

    dataKey =
      await unwrapDataKey(
        normaliseRecoveryCode(code),
        data.key_recovery_salt,
        data.key_recovery_iv,
        data.key_recovery_wrapped
      );

  } catch {

    return 'wrong';

  }

  if (newPassword) {
    await relockWithPassword(newPassword);
  }

  vaultLocked = false;

  await rememberDataKey();

  return 'opened';

}


/*
  Opens the vault with a password that is no longer the
  sign in password, typically the one from before a reset,
  and moves the lock over to the current one.
*/
async function openWithOldPassword(oldPassword, newPassword) {

  const how =
    await openVault(oldPassword);

  if (how !== 'opened') {
    return how;
  }

  if (newPassword) {
    await relockWithPassword(newPassword);
  }

  return 'opened';

}


/*
  Throws the old key away and starts again. Everything
  written under the old one is lost, which is the price of
  us not being able to recover it for you.
*/
async function resetVault(password) {

  forgetDataKey();

  await createVault(password, { replace: true });

}


/* =====================================================
   UNLOCKING, AND THE HOLDING SCREEN
===================================================== */

let pendingPassword = null;

const unlockScreen =
  document.getElementById('unlockScreen');

const unlockPassword =
  document.getElementById('unlockPassword');

const unlockError =
  document.getElementById('unlockError');

const unlockButton =
  document.getElementById('unlockButton');

const holdingScreen =
  document.getElementById('holdingScreen');


/* view and hide, on every password field */
document
  .getElementById('unlockEye')
  ?.addEventListener('click', () => {

    const showing =
      unlockPassword.type === 'text';

    unlockPassword.type =
      showing ? 'password' : 'text';

    document
      .getElementById('unlockEye')
      .setAttribute(
        'aria-label',
        showing ? 'Show password' : 'Hide password'
      );

  });


/*
  Called before the app is shown. True means the key is in
  hand, false means we put up the unlock screen instead
  and initialiseApp should stand down.
*/
async function unlockVault() {

  try {

    return await unlockVaultInner();

  } catch (error) {

    /*
      Whatever went wrong, being locked out of your own
      account is worse than being unencrypted for a session.
    */
    console.error('UNLOCK FAILED, CARRYING ON:', error);

    return true;

  }

}


async function unlockVaultInner() {

  if (!cryptoReady()) {

    /*
      No Web Crypto, which means an ancient browser or a
      page served over plain http. Carry on unencrypted
      rather than locking the user out entirely.
    */
    console.warn('NO WEB CRYPTO, ENCRYPTION OFF');

    return true;

  }

  if (dataKey) {
    return true;
  }

  /* Just signed in, so the password is still in hand */
  if (pendingPassword) {

    const password = pendingPassword;

    pendingPassword = null;

    const how =
      await openVault(password);

    if (how === 'created') {
      offerRecoveryCodeSoon();
      return true;
    }

    if (how !== 'wrong') {
      return true;
    }

    /*
      The password signs in but does not open the vault, so
      it was reset. Nothing is wiped here: the user chooses,
      with a recovery code, their old password, or, only if
      they say so, a fresh start.
    */
    showRecover(password);

    return false;

  }

  /* Same device as last time */
  if (await recallDataKey()) {
    return true;
  }

  /*
    No vault yet, so there is nothing to unlock. They carry
    on as before and one is made the next time they sign in
    with their password.
  */
  if (!(await vaultExists())) {
    return true;
  }

  /* A new device, or storage was cleared */
  showUnlock();

  return false;

}


function showUnlock() {

  vaultLocked = true;

  unlockError.textContent = '';

  unlockPassword.value = '';

  unlockScreen.classList.add('show');

  setTimeout(() => unlockPassword.focus(), 120);

}


function hideUnlock() {

  vaultLocked = false;

  unlockScreen.classList.remove('show');

}


async function tryUnlock() {

  const password =
    unlockPassword.value;

  if (!password) {
    unlockError.textContent = 'Enter your password.';
    return;
  }

  unlockButton.disabled = true;

  unlockError.textContent = 'Working...';

  const how =
    await openVault(password);

  unlockButton.disabled = false;

  if (how === 'wrong') {

    unlockError.textContent =
      'That password does not open your chats. If you have ' +
      'reset it since, they cannot be recovered.';

    return;

  }

  unlockError.textContent = '';

  hideUnlock();

  await initialiseApp();

}


unlockButton?.addEventListener('click', tryUnlock);

unlockPassword?.addEventListener('keydown', event => {
  if (event.key === 'Enter') tryUnlock();
});

document
  .getElementById('unlockForgot')
  ?.addEventListener('click', event => {

    event.preventDefault();

    hideUnlock();

    forgetDataKey();

    supabaseClient.auth.signOut().then(() => {

      showAuth();

      document
        .getElementById('authForgotButton')
        ?.click();

    });

  });

document
  .getElementById('unlockSignOut')
  ?.addEventListener('click', async () => {

    forgetDataKey();

    hideUnlock();

    await supabaseClient.auth.signOut();

    location.reload();

  });


/* =====================================================
   SHOW AND HIDE, ON EVERY PASSWORD FIELD
===================================================== */

document.addEventListener('click', event => {

  const button =
    event.target.closest?.('[data-eye]');

  if (!button) return;

  const input =
    document.getElementById(button.dataset.eye);

  if (!input) return;

  const showing =
    input.type === 'text';

  input.type =
    showing ? 'password' : 'text';

  const label =
    showing ? 'Show password' : 'Hide password';

  button.setAttribute('aria-label', label);
  button.title = label;

});


/* =====================================================
   FOLDING CARDS IN MY PROFILE

   Shut until tapped, one open at a time, and the one you
   open comes to the top of the panel.
===================================================== */

function toggleFold(id) {

  /* in My profile a section is picked, never folded */
  showProfilePanel(id);
  return;

  const card =
    document.getElementById(id);

  if (!card) return;

  const opening =
    !card.classList.contains('open');

  const holder =
    card.closest('.profileCard');

  [...(holder?.querySelectorAll('.foldCard') || [])]
    .forEach(one => one.classList.remove('open'));

  card.classList.toggle('open', opening);

  if (opening && holder) {

    requestAnimationFrame(() => {

      const top =
        card.offsetTop - holder.offsetTop - 8;

      if (typeof holder.scrollTo === 'function') {
        holder.scrollTo({ top, behavior: 'smooth' });
      } else {
        holder.scrollTop = top;
      }

    });

  }

}

document.addEventListener('click', event => {

  const summary =
    event.target.closest?.('.foldSummary');

  if (summary) {
    toggleFold(summary.dataset.fold);
  }

});


function setFold(id, state, note) {

  const card =
    document.getElementById(id);

  if (!card) return;

  card.classList.remove('good', 'warn', 'bad');

  if (state) card.classList.add(state);

  const noteEl =
    card.querySelector('.foldNote');

  if (noteEl && note) noteEl.textContent = note;

}


/*
  What the security cards should say, drawn each time My
  profile opens.
*/
async function paintImages() {

  const card =
    document.getElementById('foldImages');

  if (!card) return;

  if (guestMode || !currentUser) {
    card.style.display = 'none';
    return;
  }

  card.style.display = '';

  let usage;

  try {

    const response =
      await fetch(`${API_BASE}/api/account/usage`, {
        headers: await apiHeaders()
      });

    usage = await response.json();

    if (!response.ok) throw new Error(usage?.error);

  } catch (error) {

    setFold('foldImages', 'warn', 'Could not load your totals just now');

    return;

  }

  const put = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  put('tallyFree', usage.freeLeft);
  put('tallyPaid', usage.paidLeft);
  put('tallyTotal', usage.balance);
  put('tallyMade', usage.imagesMade);
  put('tallyPacks', usage.packsBought);

  const topUp =
    document.getElementById('tallyTopUp');

  if (usage.unlimited) {

    const why =
      usage.unlimitedReason === 'admin'
        ? 'Admin account, no limit'
        : usage.unlimitedReason === 'coupon'
          ? 'Your coupon gives you no limit'
          : 'The paywall is off, images are free right now';

    put('imagesHeadline', 'Your images, unlimited');

    setFold('foldImages', null, why);

    if (topUp) topUp.style.display = 'none';

    return;

  }

  if (topUp) topUp.style.display = '';

  const total = usage.balance;

  put('imagesHeadline', `${total} ${total === 1 ? 'image' : 'images'} left`);

  setFold(
    'foldImages',
    total === 0 ? 'bad' : total <= 10 ? 'warn' : null,
    `${usage.freeLeft} free, ${usage.paidLeft} paid`
  );

}

document
  .getElementById('tallyTopUp')
  ?.addEventListener('click', () => {
    openPaywall('topup');
  });


async function paintSecurity() {

  paintImages();

  if (guestMode || !currentUser) {

    ['foldPassword', 'foldRecovery', 'foldData']
      .forEach(id => {
        const card = document.getElementById(id);
        if (card) card.style.display = 'none';
      });

    return;

  }

  ['foldPassword', 'foldRecovery', 'foldData']
    .forEach(id => {
      const card = document.getElementById(id);
      if (card) card.style.display = '';
    });

  const hasCode =
    await hasRecoveryCode();

  setFold(
    'foldRecovery',
    hasCode ? 'good' : 'bad',
    hasCode
      ? 'Set. Make a new one if you have lost it'
      : 'Not set. Without one, a forgotten password loses your chats'
  );

  document.getElementById('recoveryMake').textContent =
    hasCode
      ? 'Make a new recovery code'
      : 'Make my recovery code';

}


/* =====================================================
   THE RECOVERY CODE, SHOWN ONCE
===================================================== */

const recoveryCodeScreen =
  document.getElementById('recoveryCodeScreen');

let shownRecoveryCode = '';


function showRecoveryCode(code) {

  shownRecoveryCode = code;

  document.getElementById('recoveryCodeText').textContent =
    code;

  recoveryCodeScreen.classList.add('show');

}


/*
  A brand new vault gets its recovery code offered once
  the app is up, rather than in the middle of signing in.
*/
function offerRecoveryCodeSoon() {

  setTimeout(async () => {

    try {

      if (!dataKey || (await hasRecoveryCode())) return;

      showRecoveryCode(await createRecoveryCode());

    } catch (error) {

      console.error('RECOVERY CODE NOT MADE:', error);

    }

  }, 1200);

}


document
  .getElementById('recoveryCopy')
  ?.addEventListener('click', () => {

    navigator.clipboard
      ?.writeText(shownRecoveryCode)
      .then(() => {

        const button =
          document.getElementById('recoveryCopy');

        button.textContent = 'Copied';

        setTimeout(() => {
          button.textContent = 'Copy';
        }, 1400);

      })
      .catch(() => {});

  });

document
  .getElementById('recoveryDownload')
  ?.addEventListener('click', () => {

    const text =
      'Natter AI recovery code\n\n' +
      `${shownRecoveryCode}\n\n` +
      `Account: ${currentUser?.email || ''}\n` +
      `Made: ${new Date().toLocaleString('en-GB')}\n\n` +
      'If you forget your password, this code unlocks your ' +
      'chats. Keep it private. Anyone with it and access to ' +
      'your email can read your history.\n';

    const link =
      document.createElement('a');

    link.href =
      URL.createObjectURL(
        new Blob([text], { type: 'text/plain' })
      );

    link.download = 'natter-recovery-code.txt';

    document.body.appendChild(link);
    link.click();
    link.remove();

  });

document
  .getElementById('recoveryDone')
  ?.addEventListener('click', () => {

    shownRecoveryCode = '';

    document.getElementById('recoveryCodeText').textContent = '';

    recoveryCodeScreen.classList.remove('show');

    paintSecurity();

  });


document
  .getElementById('recoveryMake')
  ?.addEventListener('click', async () => {

    const result =
      document.getElementById('recoveryResult');

    result.textContent = '';

    try {

      showRecoveryCode(await createRecoveryCode());

    } catch (error) {

      result.textContent =
        error?.message || 'Could not make a code.';

    }

  });


/* =====================================================
   CHANGING THE PASSWORD

   The data key stays exactly as it is, only the lock on it
   changes, so no chat is lost. If Supabase refuses the new
   password, the old lock goes back on.
===================================================== */

document
  .getElementById('pwSave')
  ?.addEventListener('click', async () => {

    const result =
      document.getElementById('pwResult');

    const button =
      document.getElementById('pwSave');

    const current =
      document.getElementById('pwCurrent').value;

    const next =
      document.getElementById('pwNew').value;

    const again =
      document.getElementById('pwConfirm').value;

    result.style.color = '#ff8585';

    if (!current || !next) {
      result.textContent = 'Fill in both passwords.';
      return;
    }

    if (next.length < 6) {
      result.textContent = 'The new one needs at least 6 characters.';
      return;
    }

    if (next !== again) {
      result.textContent = 'The two new passwords do not match.';
      return;
    }

    if (next === current) {
      result.textContent = 'That is the same as your current one.';
      return;
    }

    button.disabled = true;

    result.style.color = '#9b90ab';
    result.textContent = 'Working...';

    let before = null;

    try {

      /* prove it is really them before touching anything */
      const { error: checkError } =
        await supabaseClient.auth.signInWithPassword({
          email: currentUser.email,
          password: current
        });

      if (checkError) {
        throw new Error('Your current password is not right.');
      }

      if (dataKey) {
        before = await relockWithPassword(next);
      }

      const { error } =
        await supabaseClient.auth.updateUser({
          password: next
        });

      if (error) {

        if (before) {
          await restorePasswordLock(before);
        }

        throw error;

      }

      ['pwCurrent', 'pwNew', 'pwConfirm'].forEach(id => {
        document.getElementById(id).value = '';
      });

      result.style.color = '#9ee6bd';

      result.textContent =
        'Password changed. Your chats came with it.';

      setFold('foldPassword', 'good', 'Changed just now');

    } catch (error) {

      result.style.color = '#ff8585';

      result.textContent =
        error?.message || 'Could not change it.';

    }

    button.disabled = false;

  });

document
  .getElementById('pwForgot')
  ?.addEventListener('click', event => {

    event.preventDefault();

    document
      .getElementById('unlockForgot')
      ?.click();

  });


/* =====================================================
   GETTING BACK IN AFTER A RESET
===================================================== */

const recoverScreen =
  document.getElementById('recoverScreen');

const recoverError =
  document.getElementById('recoverError');

let recoverNewPassword = null;

let freshArmed = false;


function showRecover(newPassword) {

  recoverNewPassword = newPassword;

  freshArmed = false;

  recoverError.textContent = '';

  document.getElementById('recoverFresh').textContent =
    'Start fresh';

  document.getElementById('recoverFreshText').textContent =
    'Neither? You can carry on with a fresh start. Your old ' +
    'chats stay locked for good.';

  recoverScreen.classList.add('show');

}


async function finishRecover() {

  recoverNewPassword = null;

  recoverScreen.classList.remove('show');

  await initialiseApp();

}


document
  .getElementById('recoverWithCode')
  ?.addEventListener('click', async () => {

    const code =
      document.getElementById('recoverCode').value;

    if (normaliseRecoveryCode(code).length < 20) {
      recoverError.textContent =
        'A recovery code is 20 letters and numbers.';
      return;
    }

    recoverError.textContent = 'Working...';

    const how =
      await openWithRecoveryCode(code, recoverNewPassword);

    if (how === 'none') {
      recoverError.textContent =
        'This account never had a recovery code made.';
      return;
    }

    if (how !== 'opened') {
      recoverError.textContent =
        'That code does not open your chats.';
      return;
    }

    await finishRecover();

  });

document
  .getElementById('recoverWithPassword')
  ?.addEventListener('click', async () => {

    const old =
      document.getElementById('recoverOldPassword').value;

    if (!old) {
      recoverError.textContent = 'Enter your old password.';
      return;
    }

    recoverError.textContent = 'Working...';

    const how =
      await openWithOldPassword(old, recoverNewPassword);

    if (how !== 'opened') {
      recoverError.textContent =
        'That password does not open your chats either.';
      return;
    }

    await finishRecover();

  });

/*
  Two taps, the first one saying plainly what it costs.
*/
document
  .getElementById('recoverFresh')
  ?.addEventListener('click', async () => {

    const button =
      document.getElementById('recoverFresh');

    if (!freshArmed) {

      freshArmed = true;

      document.getElementById('recoverFreshText').textContent =
        'Are you sure? Every chat and picture you made before ' +
        'the reset stays locked forever. Nobody, including us, ' +
        'can get them back.';

      button.textContent = 'Yes, start fresh';

      return;

    }

    button.disabled = true;

    await resetVault(recoverNewPassword);

    button.disabled = false;

    offerRecoveryCodeSoon();

    await finishRecover();

  });


/* =====================================================
   EXPORTING EVERYTHING

   One markdown file with every chat, decrypted here in the
   browser. Nothing readable passes through our server to
   make it.
===================================================== */

async function exportAllChats(button) {

  const label =
    button?.textContent;

  if (button) {
    button.disabled = true;
    button.textContent = 'Gathering your chats...';
  }

  try {

    let chatRows = [];
    let messageRows = [];

    if (guestMode) {

      chatRows = guestChats();

      chatRows.forEach(item => {
        guestMessages(item.id).forEach(message => {
          messageRows.push({ ...message, chat_id: item.id });
        });
      });

    } else {

      const { data: chatsData, error: chatsError } =
        await supabaseClient
          .from('chats')
          .select('id,title,created_at')
          .eq('user_id', currentUser.id)
          .order('created_at', { ascending: true });

      if (chatsError) throw chatsError;

      chatRows =
        await decRows(chatsData, ['title']);

      for (let from = 0; from < 20000; from += 500) {

        const { data, error } =
          await supabaseClient
            .from('messages')
            .select('chat_id,role,content,image_url,created_at')
            .eq('user_id', currentUser.id)
            .order('created_at', { ascending: true })
            .range(from, from + 499);

        if (error) throw error;

        messageRows.push(
          ...(await decRows(data, ['content']))
        );

        if (!data || data.length < 500) break;

      }

    }

    const when =
      value => value
        ? new Date(value).toLocaleString('en-GB')
        : '';

    const lines = [
      '# Natter AI, all chats',
      '',
      `Exported ${when(new Date())}` +
        (currentUser?.email ? ` for ${currentUser.email}` : ''),
      '',
      `${chatRows.length} chats, ${messageRows.length} messages.`,
      'Pictures are listed but not included, save any you want',
      'to keep from inside each chat.',
      ''
    ];

    chatRows.forEach(item => {

      lines.push('---', '', `## ${item.title || 'Untitled chat'}`, '');

      if (item.created_at) {
        lines.push(`_Started ${when(item.created_at)}_`, '');
      }

      messageRows
        .filter(message => String(message.chat_id) === String(item.id))
        .forEach(message => {

          const who =
            message.role === 'user' ? 'You' : 'Natter';

          const picture =
            message.image_url ? ' _[picture]_' : '';

          lines.push(
            `**${who}**${picture}`,
            '',
            message.content || '',
            ''
          );

        });

    });

    const link =
      document.createElement('a');

    link.href =
      URL.createObjectURL(
        new Blob([lines.join('\n')], { type: 'text/markdown' })
      );

    link.download =
      `natter-all-chats-${new Date()
        .toISOString()
        .slice(0, 10)}.md`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    if (button) button.textContent = 'Downloaded';

  } catch (error) {

    console.error('EXPORT ALL ERROR:', error);

    if (button) button.textContent = 'Export failed, try again';

  }

  if (button) {

    setTimeout(() => {
      button.disabled = false;
      button.textContent = label;
    }, 2200);

  }

}

document
  .getElementById('exportAll')
  ?.addEventListener('click', event => {
    exportAllChats(event.currentTarget);
  });


/* =====================================================
   DELETING THE ACCOUNT
===================================================== */

const deleteScreen =
  document.getElementById('deleteScreen');

const deleteConfirm =
  document.getElementById('deleteConfirm');

const deleteGo =
  document.getElementById('deleteGo');

const deleteError =
  document.getElementById('deleteError');


document
  .getElementById('deleteStart')
  ?.addEventListener('click', () => {

    deleteConfirm.value = '';

    deleteGo.disabled = true;

    deleteError.textContent = '';

    deleteScreen.classList.add('show');

  });

document
  .getElementById('deleteCancel')
  ?.addEventListener('click', () => {
    deleteScreen.classList.remove('show');
  });

document
  .getElementById('deleteExport')
  ?.addEventListener('click', event => {
    exportAllChats(event.currentTarget);
  });

deleteConfirm?.addEventListener('input', () => {

  deleteGo.disabled =
    deleteConfirm.value.trim().toUpperCase() !== 'DELETE';

});

deleteGo?.addEventListener('click', async () => {

  deleteGo.disabled = true;

  deleteError.style.color = '#9b90ab';
  deleteError.textContent = 'Deleting...';

  try {

    const response =
      await fetch(`${API_BASE}/api/account/delete`, {
        method: 'POST',
        headers: await apiHeaders(),
        body: JSON.stringify({ confirm: 'DELETE' })
      });

    const data =
      await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data?.error || 'Could not delete the account.');
    }

    /* nothing of theirs is left behind on this device either */
    forgetDataKey();

    try {

      Object.keys(localStorage)
        .filter(key => key.startsWith('nastivee'))
        .forEach(key => localStorage.removeItem(key));

    } catch {}

    await supabaseClient.auth.signOut().catch(() => {});

    deleteScreen.classList.remove('show');

    profileOverlay?.classList.remove('show');

    currentUser = null;

    showAuth();

    authError.style.color = '#9ee6bd';

    authError.textContent =
      'Your account and everything in it has been deleted.';

  } catch (error) {

    deleteError.style.color = '#ff8585';

    deleteError.textContent = error.message;

    deleteGo.disabled = false;

  }

});


/* =====================================================
   THE HOLDING SCREEN

   While the site is being prepared, only the people on
   the admin list get in. Everybody else, signed in or
   not, sees the holding page.
===================================================== */

function showHolding() {

  holdingScreen.classList.add('show');

}

document
  .getElementById('holdingSignOut')
  ?.addEventListener('click', async () => {

    forgetDataKey();

    if (guestMode) {
      stopGuestMode();
    }

    await supabaseClient.auth.signOut();

    location.reload();

  });


/*
  A guest has no token, so ask the open question.
*/
async function siteIsHolding() {

  try {

    const response =
      await fetch(`${API_BASE}/api/account`);

    const data =
      await response.json();

    return data?.holding === true;

  } catch {

    return false;

  }

}


/* =====================================================
   THE PAYWALL

   Images cost money to make, so each one spends a credit.
   Credits come from a five pound pack, or from a coupon
   that opens the gate for good.
===================================================== */

const creditsRow =
  document.getElementById('creditsRow');

const creditsCount =
  document.getElementById('creditsCount');

const creditsSub =
  document.getElementById('creditsSub');

const payOverlay =
  document.getElementById('payOverlay');

const payTitle =
  document.getElementById('payTitle');

const payLead =
  document.getElementById('payLead');

const payPrice =
  document.getElementById('payPrice');

const payPackText =
  document.getElementById('payPackText');

const payBuy =
  document.getElementById('payBuy');

const payCoupon =
  document.getElementById('payCoupon');

const payMessage =
  document.getElementById('payMessage');


let account = {
  signedIn: false,
  credits: 0,
  unlimited: false,
  packImages: 100,
  packPricePence: 500,
  canBuy: false
};


function money(pence) {

  return pence % 100 === 0
    ? `\u00a3${pence / 100}`
    : `\u00a3${(pence / 100).toFixed(2)}`;

}


/*
  Asks the server what this account can do, then redraws
  anything that depends on it.
*/
async function refreshAccount() {

  if (guestMode || !currentUser) {
    account.signedIn = false;
    drawCredits();
    return;
  }

  try {

    const response =
      await fetch(`${API_BASE}/api/account`, {
        headers: await apiHeaders()
      });

    if (!response.ok) return;

    account =
      await response.json();

  } catch (error) {

    console.error('ACCOUNT ERROR:', error);

  }

  drawCredits();

  adminButton?.classList.toggle(
    'show',
    account.admin === true
  );

  paintTestFeatures();

  if (account.admin !== true && videoMode) {
    setVideoMode(false);
  }

  adminButton?.classList.toggle(
    'hasAlerts',
    account.admin === true && (account.alerts || 0) > 0
  );

}


/*
  Image balances live in My profile only, never the
  sidebar. If My profile is open, keep it current.
*/
function drawCredits() {

  if (
    typeof profileOverlay !== 'undefined' &&
    profileOverlay?.classList.contains('show')
  ) {
    paintImages();
  }

  if (!creditsRow) return;

  if (!account.signedIn) {
    creditsRow.classList.remove('show');
    return;
  }

  creditsRow.classList.add('show');

  creditsRow.classList.remove('low', 'empty');

  if (account.unlimited) {

    const reason =
      account.unlimitedReason;

    const left =
      account.credits || 0;

    creditsCount.textContent =
      reason === 'paywall_off'
        ? 'Images are free right now'
        : 'Unlimited images';

    creditsSub.textContent =
      reason === 'coupon'
        ? 'Your coupon is doing the work.'
        : reason === 'admin'
          ? 'Admin account.'
          : reason === 'paywall_off'
            ? `The paywall is off. ${left} ` +
              `${left === 1 ? 'image' : 'images'} banked for when it is on.`
            : 'No limit on this account.';

    document
      .getElementById('topUpButton')
      ?.style.setProperty('display', 'none');

    return;

  }

  document
    .getElementById('topUpButton')
    ?.style.removeProperty('display');

  const left = account.credits || 0;

  creditsCount.textContent =
    left === 1
      ? '1 image left'
      : `${left} images left`;

  creditsSub.textContent =
    `${money(account.packPricePence)} for ` +
    `${account.packImages} more.`;

  if (left === 0) {
    creditsRow.classList.add('empty');
  } else if (left <= 10) {
    creditsRow.classList.add('low');
  }

}


function sayOnPaywall(text, good) {

  payMessage.textContent = text;

  payMessage.className =
    `payMessage show ${good ? 'good' : 'bad'}`;

}


function openPaywall(reason) {

  if (guestMode || !currentUser) {
    showGuestImageNotice();
    return;
  }

  payMessage.className = 'payMessage';

  payTitle.textContent =
    reason === 'topup'
      ? 'Top up'
      : 'Out of images';

  payLead.textContent =
    reason === 'topup'
      ? 'Add more images to your account whenever you like.'
      : 'Your images have run out. Grab a pack to carry on, ' +
        'or enter a coupon if you have one.';

  payPrice.textContent =
    money(account.packPricePence || 500);

  payPackText.textContent =
    `${account.packImages || 100} images`;

  payBuy.disabled =
    account.canBuy === false;

  payBuy.textContent =
    account.canBuy === false
      ? 'Card payments coming shortly'
      : 'Buy with card';

  payOverlay.classList.add('show');

}


function closePaywall() {
  payOverlay.classList.remove('show');
}


document
  .getElementById('topUpButton')
  ?.addEventListener('click', () => openPaywall('topup'));

document
  .getElementById('payClose')
  ?.addEventListener('click', closePaywall);

payOverlay?.addEventListener('click', event => {
  if (event.target === payOverlay) {
    closePaywall();
  }
});


payBuy?.addEventListener('click', async () => {

  payBuy.disabled = true;

  payBuy.textContent = 'Opening Stripe...';

  try {

    const response =
      await fetch(`${API_BASE}/api/checkout`, {
        method: 'POST',
        headers: await apiHeaders(),
        body: '{}'
      });

    const data =
      await response.json();

    if (!response.ok || !data?.url) {

      throw new Error(
        data?.error || 'Could not start checkout.'
      );

    }

    location.href = data.url;

  } catch (error) {

    sayOnPaywall(error.message, false);

    payBuy.disabled = false;

    payBuy.textContent = 'Buy with card';

  }

});


async function applyCoupon() {

  const code =
    (payCoupon.value || '').trim();

  if (!code) {
    sayOnPaywall('Enter a code first.', false);
    return;
  }

  try {

    const response =
      await fetch(`${API_BASE}/api/coupon`, {
        method: 'POST',
        headers: await apiHeaders(),
        body: JSON.stringify({ code })
      });

    const data =
      await response.json();

    if (!response.ok) {

      throw new Error(
        data?.error || 'That code did not work.'
      );

    }

    sayOnPaywall(
      data.message || 'Code accepted.',
      true
    );

    payCoupon.value = '';

    await refreshAccount();

    setTimeout(closePaywall, 1600);

  } catch (error) {

    sayOnPaywall(error.message, false);

  }

}


document
  .getElementById('payCouponButton')
  ?.addEventListener('click', applyCoupon);

payCoupon?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    applyCoupon();
  }
});


/*
  Back from Stripe. The webhook does the real work, so
  give it a beat and then read the balance again.
*/

function checkPaymentReturn() {

  const params =
    new URLSearchParams(location.search);

  if (!params.has('paid')) return;

  const paid =
    params.get('paid') === '1';

  history.replaceState(
    null,
    '',
    location.pathname
  );

  if (!paid) return;

  let tries = 0;

  const poll = async () => {

    tries += 1;

    const before =
      account.credits;

    await refreshAccount();

    if (account.credits > before || tries >= 6) {

      openPaywall('topup');

      sayOnPaywall(
        account.credits > before
          ? `Payment received. You have ${account.credits} ` +
            'images to play with.'
          : 'Payment received. Your images will appear here ' +
            'in a moment.',
        true
      );

      return;

    }

    setTimeout(poll, 1500);

  };

  setTimeout(poll, 1200);

}


/* =====================================================
   ADMIN

   Only for the emails the server calls admins. It asks
   the server every time, so hiding the button is a
   courtesy, not the lock.
===================================================== */

const adminButton =
  document.getElementById('adminButton');

const adminOverlay =
  document.getElementById('adminOverlay');

const adminCard =
  document.getElementById('adminCard');

let adminData = null;


function adminSay(where, text, good) {

  const box =
    document.getElementById(where);

  if (!box) return;

  box.textContent = text;

  box.className =
    `adminResult show ${good ? 'good' : 'bad'}`;

}


/*
  Cards open one at a time, and the one you opened comes
  to the top of the panel so you are never left reading
  halfway down.
*/
function toggleAdminSection(id) {

  /* on the admin page a section is shown, never folded away */
  showAdminPage(id);
  return;

  const section =
    document.getElementById(id);

  if (!section) return;

  const opening =
    !section.classList.contains('open');

  [...adminCard.querySelectorAll('.adminSection')]
    .forEach(one => one.classList.remove('open'));

  section.classList.toggle('open', opening);

  if (opening && id === 'adminActivity' && statData) {
    requestAnimationFrame(paintStats);
  }

  if (opening) {

    requestAnimationFrame(() => {

      const top =
        section.offsetTop - adminCard.offsetTop - 8;

      if (typeof adminCard.scrollTo === 'function') {

        adminCard.scrollTo({
          top,
          behavior: 'smooth'
        });

      } else {

        adminCard.scrollTop = top;

      }

    });

  }

}


adminCard?.addEventListener('click', event => {

  const summary =
    event.target.closest?.('.adminSummary');

  if (summary) {
    toggleAdminSection(summary.dataset.section);
  }

});


function setSectionState(id, state, note) {

  const section =
    document.getElementById(id);

  if (!section) return;

  section.classList.remove('good', 'warn', 'bad');

  if (state) section.classList.add(state);

  const noteEl =
    document.getElementById(`${id}Note`);

  if (noteEl) {
    noteEl.textContent = note;
  }

}


function paintAdmin() {

  if (!adminData) return;

  loadRulesFromAdmin(adminData.settings);

  lessonsData = adminData.settings?.lessons || { auto: true, items: [] };
  paintLessons();

  const c =
    adminData.configured || {};

  document.getElementById('adminSub').textContent =
    (adminData.testMode
      ? 'Stripe in test mode'
      : (c.stripeKey ? 'Stripe live' : 'Stripe not connected')) +
    (adminData.accounts !== null
      ? `, ${adminData.accounts} accounts`
      : '');

  /* --- payments --- */

  const present =
    adminData.present || {};

  const problems =
    adminData.problems || {};

  /*
    A key being present is not the same as a key working,
    so say which it is.
  */
  const checks = [
    [
      'Supabase service key',
      c.serviceKey,
      c.serviceKey
        ? 'Working'
        : (present.serviceKey
            ? (problems.serviceKey || 'Rejected')
            : 'Not set on Render, Supabase Settings, API, ' +
              'the Secret keys section')
    ],
    [
      'Stripe secret key',
      c.stripeKey,
      c.stripeKey
        ? 'Working'
        : (present.stripeKey
            ? (problems.stripeKey || 'Rejected')
            : 'Not set on Render')
    ],
    [
      'Stripe webhook secret',
      c.webhook,
      c.webhook ? 'Set' : 'Not set on Render'
    ],
    [
      'OpenAI key',
      c.openai,
      c.openai ? 'Set' : 'Not set on Render'
    ]
  ];

  document.getElementById('adminChecks').innerHTML =
    checks
      .map(([name, ok, why]) =>
        '<li class="adminListItem">' +
        `<code>${name}` +
        `<span class="adminWhy">${why}</span></code>` +
        `<span class="adminTick ${ok ? 'yes' : 'no'}">` +
        `${ok ? 'OK' : 'NO'}</span>` +
        '</li>'
      )
      .join('') +
    (adminData.serviceKeyShape && !c.serviceKey
      ? '<li class="adminListItem"><code>The key it is using' +
        `<span class="adminWhy">${adminData.serviceKeyShape}</span>` +
        '</code></li>'
      : '') +
    (adminData.webhookSecretShape
      ? '<li class="adminListItem"><code>Webhook secret in use' +
        `<span class="adminWhy">${adminData.webhookSecretShape}, ` +
        'compare with the signing secret on the endpoint in Stripe' +
        '</span></code></li>'
      : '') +
    (() => {

      const last = adminData.lastWebhook;

      if (!last) {
        return '<li class="adminListItem"><code>Last payment event' +
          '<span class="adminWhy">None since the server last started' +
          '</span></code></li>';
      }

      const when =
        new Date(last.at).toLocaleString('en-GB');

      return '<li class="adminListItem"><code>Last payment event' +
        `<span class="adminWhy">${when}. ${last.message}</span></code>` +
        `<span class="adminTick ${last.ok ? 'yes' : 'no'}">` +
        `${last.ok ? 'OK' : 'NO'}</span></li>`;

    })();

  document.getElementById('adminWebhookUrl').textContent =
    adminData.webhookUrl || '';

  document.getElementById('alertPushHint').textContent =
    adminData.alertPushConfigured
      ? 'New alerts are also sent to your alert channel.'
      : 'Tip: put a Discord or Slack webhook address in ' +
        'ALERT_WEBHOOK_URL on Render and new alerts reach your ' +
        'phone too.';

  const missing =
    checks.filter(one => !one[1]).length +
    (adminData.lastWebhook && !adminData.lastWebhook.ok ? 1 : 0);

  setSectionState(
    'adminStatus',
    missing === 0 ? 'good' : (missing > 2 ? 'bad' : 'warn'),
    missing === 0
      ? 'Everything is connected'
      : `${missing} still to set on Render`
  );

  /* --- pack --- */

  const set = adminData.settings || {};

  const price =
    document.getElementById('adminPrice');

  price.value = set.pack_price_pence;

  document.getElementById('adminPriceHint').textContent =
    `That is ${money(set.pack_price_pence || 0)}.`;

  document.getElementById('adminImages').value =
    set.pack_images;

  document.getElementById('adminStarter').value =
    set.starter_credits;

  document.getElementById('adminPeek').value =
    Number.isFinite(Number(set.peek_seconds)) && set.peek_seconds !== null && set.peek_seconds !== undefined
      ? set.peek_seconds
      : (account?.peekSeconds ?? 30);

  document.getElementById('adminCoupon').value =
    set.coupon_code || '';

  const paywallSwitch =
    document.getElementById('adminPaywallSwitch');

  paywallSwitch.classList.toggle(
    'on',
    set.paywall_enabled !== false
  );

  paywallSwitch.textContent =
    set.paywall_enabled === false ? 'Off' : 'On';

  const holdingSwitch =
    document.getElementById('adminHoldingSwitch');

  holdingSwitch.classList.toggle(
    'on',
    set.holding_mode !== false
  );

  holdingSwitch.textContent =
    set.holding_mode === false ? 'Off' : 'On';

  setSectionState(
    'adminPack',
    (set.holding_mode !== false || set.paywall_enabled === false)
      ? 'warn'
      : 'good',
    set.holding_mode !== false
      ? 'Holding page is up, only admins can get in'
      : (set.paywall_enabled === false
          ? 'Paywall is off, images are free for everyone'
          : `${money(set.pack_price_pence || 0)} for ` +
            `${set.pack_images} images`)
  );

}


async function loadAdmin() {

  try {

    const response =
      await fetch(`${API_BASE}/api/admin/overview`, {
        headers: await apiHeaders()
      });

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(data?.error || 'Could not load.');
    }

    adminData = data;

    paintAdmin();

  } catch (error) {

    adminSay('adminSettingsResult', error.message, false);

  }

}


adminButton?.addEventListener('click', async () => {

  adminOverlay.classList.add('show');

  let last = null;
  try { last = localStorage.getItem(ADMIN_PAGE_KEY); } catch {}
  showAdminPage(last || 'adminAlerts');

  loadAlerts();

  loadRefusals();

  loadStats(statDays);

  await loadAdmin();


});

document
  .getElementById('adminClose')
  ?.addEventListener('click', () => {
    adminOverlay.classList.remove('show');
    setAdminDrawer(false);
  });

document
  .getElementById('adminRefresh')
  ?.addEventListener('click', loadAdmin);

document
  .getElementById('adminCopyWebhook')
  ?.addEventListener('click', () => {

    navigator.clipboard
      ?.writeText(adminData?.webhookUrl || '')
      .then(() => {

        const button =
          document.getElementById('adminCopyWebhook');

        button.textContent = 'Copied';

        setTimeout(() => {
          button.textContent = 'Copy';
        }, 1200);

      })
      .catch(() => {});

  });


document
  .getElementById('adminHoldingSwitch')
  ?.addEventListener('click', event => {

    const button = event.currentTarget;

    const on =
      !button.classList.contains('on');

    button.classList.toggle('on', on);

    button.textContent = on ? 'On' : 'Off';

  });

document
  .getElementById('adminPaywallSwitch')
  ?.addEventListener('click', event => {

    const button = event.currentTarget;

    const on =
      !button.classList.contains('on');

    button.classList.toggle('on', on);

    button.textContent = on ? 'On' : 'Off';

  });


document
  .getElementById('adminSavePeek')
  ?.addEventListener('click', async () => {

    const button = document.getElementById('adminSavePeek');

    button.disabled = true;

    try {

      const response =
        await fetch(`${API_BASE}/api/admin/settings`, {
          method: 'POST',
          headers: await apiHeaders(),
          body: JSON.stringify({
            peek_seconds: Number(document.getElementById('adminPeek').value)
          })
        });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || 'Could not save.');
      }

      const seconds = Number(document.getElementById('adminPeek').value);

      account.peekSeconds = seconds;

      restartPeeking?.();

      paintTestFeatures();

      adminSay(
        'adminPeekResult',
        data.volatile
          ? 'Working now, but not saved to the database yet, so it goes back to 30 seconds if the server restarts. ' +
            'Run the robot timer SQL in Supabase to make it stick.'
          : (seconds === 0 ? 'Saved. The robot is off for everyone.' : `Saved. He peeks every ${seconds} to ${seconds + 10} seconds.`),
        !data.volatile
      );

    } catch (error) {

      adminSay('adminPeekResult', error.message, false);

    } finally {

      button.disabled = false;

    }

  });


document
  .getElementById('adminSaveSettings')
  ?.addEventListener('click', async () => {

    const button =
      document.getElementById('adminSaveSettings');

    button.disabled = true;

    try {

      const response =
        await fetch(`${API_BASE}/api/admin/settings`, {

          method: 'POST',

          headers: await apiHeaders(),

          body: JSON.stringify({

            holding_mode:
              document
                .getElementById('adminHoldingSwitch')
                .classList.contains('on'),

            paywall_enabled:
              document
                .getElementById('adminPaywallSwitch')
                .classList.contains('on'),

            pack_price_pence:
              Number(document.getElementById('adminPrice').value),

            pack_images:
              Number(document.getElementById('adminImages').value),

            starter_credits:
              Number(document.getElementById('adminStarter').value),

            coupon_code:
              document.getElementById('adminCoupon').value

          })

        });

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(data?.error || 'Could not save.');
      }

      adminData.settings = data.settings;

      paintAdmin();

      adminSay(
        'adminSettingsResult',
        data.volatile
          ? 'Applied, and working right now. It could not be ' +
            'written to the database though, so it will go back ' +
            'to the old setting if the server restarts. Fix the ' +
            'Supabase service key to make it stick.'
          : 'Saved.',
        !data.volatile
      );

      /* the card the user was working in comes back to the top */
      toggleAdminSection('adminPack');

      refreshAccount();

    } catch (error) {

      adminSay('adminSettingsResult', error.message, false);

    }

    button.disabled = false;

  });


let adminPerson = null;

async function adminLookup() {

  const email =
    document.getElementById('adminLookup').value.trim();

  if (!email) {
    adminSay('adminPeopleResult', 'Enter an email.', false);
    return;
  }

  try {

    const response =
      await fetch(
        `${API_BASE}/api/admin/user?email=` +
        encodeURIComponent(email),
        { headers: await apiHeaders() }
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(data?.error || 'Not found.');
    }

    adminPerson = data;

    document.getElementById('adminPerson')
      .style.display = 'block';

    document.getElementById('adminPersonName')
      .textContent = data.email;

    document.getElementById('adminPersonStat').textContent =
      (data.unlimited
        ? 'Unlimited images'
        : `${data.credits} images left`) +
      `, joined ${new Date(data.createdAt)
        .toLocaleDateString('en-GB')}`;

    document.getElementById('adminUnlimitedButton').textContent =
      data.unlimited ? 'Take unlimited away' : 'Give unlimited';

    document.getElementById('adminPeopleResult')
      .className = 'adminResult';

  } catch (error) {

    document.getElementById('adminPerson')
      .style.display = 'none';

    adminSay('adminPeopleResult', error.message, false);

  }

}

document
  .getElementById('adminLookupButton')
  ?.addEventListener('click', adminLookup);

document
  .getElementById('adminLookup')
  ?.addEventListener('keydown', event => {
    if (event.key === 'Enter') adminLookup();
  });


async function adminGrant(body, saying) {

  try {

    const response =
      await fetch(`${API_BASE}/api/admin/grant`, {
        method: 'POST',
        headers: await apiHeaders(),
        body: JSON.stringify({
          email: adminPerson?.email,
          ...body
        })
      });

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(data?.error || 'Could not apply that.');
    }

    adminSay('adminPeopleResult', saying, true);

    await adminLookup();

    adminSay('adminPeopleResult', saying, true);

  } catch (error) {

    adminSay('adminPeopleResult', error.message, false);

  }

}

document
  .getElementById('adminGrantButton')
  ?.addEventListener('click', () => {

    const amount =
      Number(
        document.getElementById('adminGrantAmount').value
      );

    if (!amount) {
      adminSay('adminPeopleResult', 'How many?', false);
      return;
    }

    adminGrant(
      { amount },
      `${amount > 0 ? 'Added' : 'Removed'} ` +
      `${Math.abs(amount)} images.`
    );

    document.getElementById('adminGrantAmount').value = '';

  });

document
  .getElementById('adminUnlimitedButton')
  ?.addEventListener('click', () => {

    const giving =
      !adminPerson?.unlimited;

    adminGrant(
      { unlimited: giving },
      giving
        ? 'They now have unlimited images.'
        : 'Unlimited taken away.'
    );

  });


/* =====================================================
   ADMIN, ALERTS
===================================================== */

const escapeText =
  value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');


function ago(value) {

  const seconds =
    Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;

  return new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short'
  });

}


async function loadAlerts() {

  const list =
    document.getElementById('alertList');

  try {

    const response =
      await fetch(`${API_BASE}/api/admin/alerts`, {
        headers: await apiHeaders()
      });

    const data =
      await response.json();

    if (!response.ok) throw new Error(data?.error);

    paintAlerts(data.alerts || []);

  } catch (error) {

    list.innerHTML =
      '<li class="alertEmpty">Could not load alerts just now.</li>';

    setSectionState('adminAlerts', 'warn', 'Could not load alerts');

  }

}


function paintAlerts(alerts) {

  const list =
    document.getElementById('alertList');

  const high =
    alerts.filter(one => one.severity === 'high').length;

  adminButton?.classList.toggle('hasAlerts', alerts.length > 0);

  document.getElementById('alertsResolveAll').style.display =
    alerts.length ? '' : 'none';

  if (!alerts.length) {

    list.innerHTML =
      '<li class="alertEmpty">Nothing has gone wrong. ' +
      'Anything that does will show up here.</li>';

    setSectionState('adminAlerts', 'good', 'Nothing needs your attention');

    return;

  }

  setSectionState(
    'adminAlerts',
    'bad',
    `${alerts.length} open` +
      (high ? `, ${high} urgent` : '')
  );

  list.innerHTML =
    alerts.map(one =>
      `<li class="alertItem ${one.severity === 'high' ? 'high' : ''}"` +
      ` id="alert-${Number(one.id)}">` +
      '<div class="alertTop">' +
        `<span class="alertKind">${escapeText(one.kind)}</span>` +
        (one.count > 1
          ? `<span class="alertCount">x ${Number(one.count)}</span>`
          : '') +
      '</div>' +
      `<div class="alertMessage">${escapeText(one.message)}</div>` +
      '<div class="alertMeta">' +
        (one.count > 1
          ? `First ${ago(one.first_at)}, latest ${ago(one.last_at)}`
          : ago(one.last_at)) +
      '</div>' +
      (one.detail
        ? `<div class="alertDetail">${escapeText(one.detail)}</div>`
        : '') +
      `<button class="alertResolve" type="button" data-alert="${Number(one.id)}">` +
        'Dealt with' +
      '</button>' +
      '</li>'
    ).join('');

}


async function resolveAlerts(body) {

  try {

    await fetch(`${API_BASE}/api/admin/alerts/resolve`, {
      method: 'POST',
      headers: await apiHeaders(),
      body: JSON.stringify(body)
    });

  } catch {}

  await loadAlerts();

  /* keep the card you were working in at the top */
  toggleAdminSection('adminAlerts');
  toggleAdminSection('adminAlerts');

}

document
  .getElementById('alertList')
  ?.addEventListener('click', event => {

    const button =
      event.target.closest?.('[data-alert]');

    if (button) {
      button.disabled = true;
      resolveAlerts({ id: Number(button.dataset.alert) });
    }

  });

document
  .getElementById('alertsResolveAll')
  ?.addEventListener('click', () => {
    resolveAlerts({ all: true });
  });


/* =====================================================
   ADMIN, ACTIVITY

   Four small charts, one measure each, never two on one
   axis. Bars grow from a shared baseline with a 4px
   rounded top and a 2px gap between them. Every bar has a
   hover and tap target the full height of its column, and
   the same numbers sit in a table underneath.
===================================================== */

let statDays = 30;

let statData = null;

const CHART_HUE = '#8b5cf6';


function shortDay(key) {

  return new Date(`${key}T12:00:00Z`)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

}


function compact(value) {

  return value >= 10000
    ? `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}K`
    : value.toLocaleString('en-GB');

}


async function loadStats(days) {

  statDays = days;

  document
    .querySelectorAll('#rangeRow .rangeButton')
    .forEach(button => {
      button.classList.toggle(
        'active',
        Number(button.dataset.days) === days
      );
    });

  try {

    const response =
      await fetch(`${API_BASE}/api/admin/stats?days=${days}`, {
        headers: await apiHeaders()
      });

    const data =
      await response.json();

    if (!response.ok) throw new Error(data?.error);

    statData = data;

    paintStats();

  } catch (error) {

    document.getElementById('statGrid').innerHTML = '';
    document.getElementById('statCharts').innerHTML =
      `<p class="adminHint">${escapeText(error.message || 'Could not load the numbers.')}</p>`;

    setSectionState('adminActivity', 'warn', 'Could not load the numbers');

  }

}


function paintStats() {

  const t = statData.totals;

  setSectionState(
    'adminActivity',
    null,
    `Last ${statData.days} days: ${t.signups} signups, ` +
    `${t.images} images, ${money(t.pence)}`
  );

  const tiles = [
    ['Accounts in total', compact(t.accounts)],
    ['New signups', compact(t.signups)],
    ['Busiest day, people', compact(t.peakActive)],
    ['Messages sent', compact(t.messages)],
    ['Images made', compact(t.images)],
    ['Revenue', money(t.pence)]
  ];

  document.getElementById('statGrid').innerHTML =
    tiles.map(([label, value]) =>
      '<div class="statTile">' +
      `<div class="statLabel">${label}</div>` +
      `<div class="statValue">${value}</div>` +
      '</div>'
    ).join('');

  const charts = [
    ['signups', 'Signups', value => `${value} ${value === 1 ? 'signup' : 'signups'}`],
    ['activeUsers', 'People active', value => `${value} ${value === 1 ? 'person' : 'people'}`],
    ['images', 'Images made', value => `${value} ${value === 1 ? 'image' : 'images'}`],
    ['pence', 'Revenue', value => money(value)]
  ];

  const holder =
    document.getElementById('statCharts');

  holder.innerHTML =
    charts.map(([field, title], index) =>
      `<div class="statChart" id="statChart-${field}">` +
      '<div class="statChartHead">' +
        `<span class="statChartTitle">${title}</span>` +
        `<span class="statChartMax" id="statMax-${field}"></span>` +
      '</div>' +
      `<svg role="img" aria-label="${title} per day" data-field="${field}" data-index="${index}"></svg>` +
      '<div class="statAxis">' +
        `<span>${shortDay(statData.series[0].day)}</span>` +
        `<span>${shortDay(statData.series[statData.series.length - 1].day)}</span>` +
      '</div>' +
      '</div>'
    ).join('');

  charts.forEach(([field, , say]) => drawBars(field, say));

  /* the same numbers, as a table */
  const rows =
    [...statData.series].reverse();

  document.getElementById('statTable').innerHTML =
    '<table><thead><tr>' +
    '<th>Day</th><th>Signups</th><th>Active</th><th>Messages</th>' +
    '<th>Images</th><th>Revenue</th>' +
    '</tr></thead><tbody>' +
    rows.map(day =>
      '<tr>' +
      `<td>${shortDay(day.day)}</td>` +
      `<td>${day.signups}</td>` +
      `<td>${day.activeUsers}</td>` +
      `<td>${day.messages}</td>` +
      `<td>${day.images}</td>` +
      `<td>${money(day.pence)}</td>` +
      '</tr>'
    ).join('') +
    '</tbody></table>';

}


function drawBars(field, say) {

  const svg =
    document.querySelector(`#statChart-${field} svg`);

  if (!svg) return;

  const series = statData.series;

  const width =
    Math.max(200, svg.getBoundingClientRect().width || 440);

  const height = 72;

  const max =
    Math.max(1, ...series.map(day => day[field]));

  document.getElementById(`statMax-${field}`).textContent =
    field === 'pence'
      ? `peak ${money(max)}`
      : `peak ${compact(max)}`;

  const slot = width / series.length;

  /* 2px of surface between neighbours, never wider than 24 */
  const barWidth =
    Math.max(1, Math.min(24, slot - 2));

  const radius =
    Math.min(4, barWidth / 2);

  const bars = [];
  const hits = [];

  series.forEach((day, i) => {

    const value = day[field];

    const x = i * slot + (slot - barWidth) / 2;

    if (value > 0) {

      const h = Math.max(2, (value / max) * (height - 2));

      const y = height - h;

      const r = Math.min(radius, h);

      /* rounded at the data end, square at the baseline */
      bars.push(
        `<path d="M${x},${height} V${y + r} ` +
        `Q${x},${y} ${x + r},${y} H${x + barWidth - r} ` +
        `Q${x + barWidth},${y} ${x + barWidth},${y + r} V${height} Z" ` +
        `fill="${CHART_HUE}"></path>`
      );

    }

    /* the target is the whole column, bigger than the bar */
    hits.push(
      `<rect x="${i * slot}" y="0" width="${slot}" height="${height}" ` +
      `fill="transparent" data-i="${i}"></rect>`
    );

  });

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  svg.innerHTML =
    `<line x1="0" y1="${height - .5}" x2="${width}" y2="${height - .5}" ` +
    'stroke="#2c2244" stroke-width="1"></line>' +
    bars.join('') +
    hits.join('');

  const tip =
    document.getElementById('chartTip');

  const show = event => {

    const target =
      event.target.closest?.('rect[data-i]');

    if (!target) return;

    const day = series[Number(target.dataset.i)];

    tip.innerHTML =
      `${say(day[field])} <span>${shortDay(day.day)}</span>`;

    const point =
      event.touches?.[0] || event;

    tip.style.left = `${Math.min(window.innerWidth - 150, point.clientX + 12)}px`;
    tip.style.top = `${point.clientY - 38}px`;

    tip.classList.add('show');

  };

  svg.onpointermove = show;
  svg.onpointerdown = show;
  svg.onpointerleave = () => tip.classList.remove('show');

}


document
  .getElementById('rangeRow')
  ?.addEventListener('click', event => {

    const button =
      event.target.closest?.('.rangeButton');

    if (button) {
      loadStats(Number(button.dataset.days));
    }

  });

window.addEventListener('resize', () => {

  if (statData && adminOverlay?.classList.contains('show')) {
    paintStats();
  }

});


/* =====================================================
   INSTALL TO THE HOME SCREEN
===================================================== */

const installButton =
  document.getElementById('installButton');

const installOverlay =
  document.getElementById('installOverlay');

const installSteps =
  document.getElementById('installSteps');

const installLead =
  document.getElementById('installLead');

const installHost =
  document.getElementById('installHost');

let installPrompt = null;


const runningAsApp =
  window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
  window.matchMedia?.('(display-mode: window-controls-overlay)')?.matches === true ||
  window.navigator.standalone === true;


/*
  Which set of steps this browser needs. Only Chromium
  gives us a real prompt, everyone else gets told exactly
  where their own menu hides it.
*/

function installFlavour() {

  const ua = navigator.userAgent;

  const apple =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' &&
     navigator.maxTouchPoints > 1);

  if (apple) {

    return /CriOS|FxiOS|EdgiOS/.test(ua)
      ? 'ios-other'
      : 'ios';

  }

  if (/Macintosh/.test(ua) &&
      /Safari/.test(ua) &&
      !/Chrome|Chromium/.test(ua)) {
    return 'mac-safari';
  }

  if (/Firefox/.test(ua)) {
    return 'firefox';
  }

  return 'generic';

}


const SHARE_GLYPH =
  '<span class="inlineIcon">' +
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 16V3"></path>' +
  '<polyline points="8 7 12 3 16 7"></polyline>' +
  '<path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"></path>' +
  '</svg></span>';

const PLUS_GLYPH =
  '<span class="inlineIcon">' +
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3" y="3" width="18" height="18" rx="4"></rect>' +
  '<line x1="12" y1="8" x2="12" y2="16"></line>' +
  '<line x1="8" y1="12" x2="16" y2="12"></line>' +
  '</svg></span>';

const DOTS_GLYPH =
  '<span class="inlineIcon">' +
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
  'aria-hidden="true">' +
  '<circle cx="12" cy="5" r="1"></circle>' +
  '<circle cx="12" cy="12" r="1"></circle>' +
  '<circle cx="12" cy="19" r="1"></circle>' +
  '</svg></span>';


const INSTALL_GUIDES = {

  'ios': {
    lead:
      'Safari keeps this behind the Share button, it takes ' +
      'about ten seconds.',
    steps: [
      `Tap the Share button ${SHARE_GLYPH} at the bottom of ` +
        'Safari, the square with the arrow coming out of it.',
      `Scroll down the list and tap ${PLUS_GLYPH} ` +
        '<strong>Add to Home Screen</strong>.',
      'Tap <strong>Add</strong> in the top right, and Natter ' +
        'lands on your home screen with its own icon.'
    ]
  },

  'ios-other': {
    lead:
      'Chrome and Firefox on iPhone can do this, but only ' +
      'Safari adds the proper icon, so open this page in ' +
      'Safari first if you can.',
    steps: [
      `Tap the Share button ${SHARE_GLYPH} in the toolbar.`,
      `Choose ${PLUS_GLYPH} <strong>Add to Home Screen</strong>.`,
      'Tap <strong>Add</strong> to finish.'
    ]
  },

  'mac-safari': {
    lead:
      'Safari on a Mac puts this in the Share menu.',
    steps: [
      `Click the Share button ${SHARE_GLYPH} in the toolbar, ` +
        'or open the <strong>File</strong> menu.',
      'Choose <strong>Add to Dock</strong>.',
      'Click <strong>Add</strong>, and Natter sits in your ' +
        'Dock like any other app.'
    ]
  },

  'firefox': {
    lead:
      'Firefox does not install web apps, so the neatest ' +
      'route is a pinned tab or a desktop shortcut.',
    steps: [
      'Right click this tab and choose <strong>Pin Tab</strong> ' +
        'so Natter is always open.',
      'Or drag the padlock in the address bar onto your ' +
        'desktop to drop a shortcut there.',
      'Chrome, Edge and Safari can install it properly if ' +
        'you would rather have a real app icon.'
    ]
  },

  'generic': {
    lead:
      'Your browser can install this, the button is tucked ' +
      'away in its menu.',
    steps: [
      `Open the browser menu ${DOTS_GLYPH} in the top right.`,
      'Look for <strong>Install app</strong>, <strong>Install ' +
        'Natter AI</strong> or <strong>Add to Home ' +
        'screen</strong>.',
      'Confirm, and it opens in its own window from then on.'
    ]
  }

};


function showInstallSheet() {

  const guide =
    INSTALL_GUIDES[installFlavour()] ||
    INSTALL_GUIDES.generic;

  installLead.textContent = guide.lead;

  installHost.textContent = location.host;

  installSteps.innerHTML =
    guide.steps
      .map(step =>
        '<li class="installStep">' +
        '<span class="installStepNum"></span>' +
        `<span>${step}</span>` +
        '</li>'
      )
      .join('');

  installOverlay.classList.add('show');

}


function hideInstallSheet() {
  installOverlay.classList.remove('show');
}


/*
  Chromium hands us a real prompt. Everything else gets
  the sheet.
*/

window.addEventListener('beforeinstallprompt', event => {

  event.preventDefault();

  installPrompt = event;

  installButton.classList.add('show');

});


if (!runningAsApp && installButton) {
  installButton.classList.add('show');
}


installButton?.addEventListener('click', async () => {

  if (installPrompt) {

    installPrompt.prompt();

    const choice =
      await installPrompt.userChoice;

    installPrompt = null;

    if (choice?.outcome === 'accepted') {
      installButton.classList.remove('show');
    }

    return;

  }

  showInstallSheet();

});


document
  .getElementById('installClose')
  ?.addEventListener('click', hideInstallSheet);

document
  .getElementById('installDone')
  ?.addEventListener('click', hideInstallSheet);

installOverlay?.addEventListener('click', event => {
  if (event.target === installOverlay) {
    hideInstallSheet();
  }
});


window.addEventListener('appinstalled', () => {

  installButton?.classList.remove('show');

  hideInstallSheet();

  installPrompt = null;

});


/* =====================================================
   OFFER TO REMEMBER

   When someone says something that sounds worth keeping,
   suggest adding it to their profile. Nothing is saved
   without them pressing the button.
===================================================== */

const rememberPatterns = [

  /* asked outright */
  /\bremember (?:that |this[:,]? )?(.+)/i,
  /\b(?:note|keep|save) that (.+)/i,
  /\bdon'?t forget (?:that )?(.+)/i,
  /\bfor future reference[,:]? (.+)/i,

  /* who they are */
  /\bmy names? (?:is |are )?([^.,!?\n]{2,40})/i,
  /\bi(?:'m| am) called ([^.,!?\n]{2,40})/i,
  /\bthe name(?:'s| is) ([^.,!?\n]{2,40})/i,
  /\bcall me ([^.,!?\n]{2,30})/i,
  /\bi(?:'m| am) (?:a|an|the) ([^.,!?\n]{3,60})/i,
  /\bi(?:'m| am) (\d{1,2} years old[^.,!?\n]{0,20})/i,

  /* what they do and where */
  /\bi (?:work|live) (?:at|in|for|on) ([^.,!?\n]{2,60})/i,
  /\bi (?:run|own|manage) ([^.,!?\n]{2,60})/i,
  /\bmy (?:business|company|shop|takeaway|job|role) is ([^.,!?\n]{2,60})/i,
  /\bi(?:'m| am) based in ([^.,!?\n]{2,40})/i,

  /* how they want things done */
  /\bi (?:prefer|like|always want|usually want) ([^.,!?\n]{3,80})/i,
  /\bi (?:hate|dislike|never want|can'?t stand) ([^.,!?\n]{3,80})/i,
  /\balways (?:use|write|reply|answer|keep) ([^.,!?\n]{3,80})/i,
  /\bnever (?:use|write|reply|answer|mention) ([^.,!?\n]{3,80})/i,
  /\bkeep (?:it|answers|replies|things) ([^.,!?\n]{3,60})/i,

  /* people and things around them */
  /\bmy (?:wife|husband|partner|son|daughter|dog|cat|kid|kids|team) (?:is|are|is called|are called) ([^.,!?\n]{2,60})/i,
  /\bmy (?:birthday|anniversary) is ([^.,!?\n]{2,40})/i
];

function noteWorthKeeping(text) {

  const clean =
    String(text || '').trim();

  if (clean.length < 8 || clean.length > 300) {
    return null;
  }

  for (const pattern of rememberPatterns) {

    if (pattern.test(clean)) {
      return clean;
    }

  }

  return null;

}


function offerToRemember(text) {

  const note =
    noteWorthKeeping(text);

  if (!note) return;

  /* already in the profile, nothing to do */
  if (
    (memory || '')
      .toLowerCase()
      .includes(note.toLowerCase().slice(0, 40))
  ) {
    return;
  }

  const existing =
    chat.querySelector('.rememberOffer');

  existing?.remove();

  const row =
    document.createElement('div');

  row.className = 'messageRow assistant';

  const card =
    document.createElement('div');

  card.className = 'rememberOffer';

  const label =
    document.createElement('div');

  label.className = 'rememberText';

  label.textContent =
    'Add this to your profile so I remember it in every chat?';

  const quote =
    document.createElement('div');

  quote.className = 'rememberQuote';

  quote.textContent = note;

  const buttons =
    document.createElement('div');

  buttons.className = 'rememberButtons';

  const save =
    document.createElement('button');

  save.type = 'button';
  save.className = 'rememberSave';
  save.textContent = 'Save to profile';

  save.addEventListener('click', async () => {

    save.disabled = true;

    save.textContent = 'Saving...';

    memory =
      [memory, note].filter(Boolean).join('\n');

    memoryTextarea.value = memory;

    await saveMemory();

    card.classList.add('saved');

    label.textContent = 'Saved to your profile.';

    quote.remove();

    buttons.remove();

  });

  const dismiss =
    document.createElement('button');

  dismiss.type = 'button';
  dismiss.className = 'rememberNo';
  dismiss.textContent = 'No thanks';

  dismiss.addEventListener('click', () => row.remove());

  buttons.appendChild(dismiss);
  buttons.appendChild(save);

  card.appendChild(label);
  card.appendChild(quote);
  card.appendChild(buttons);

  row.appendChild(card);

  chat.appendChild(row);

  scrollToBottom();

}


/* =====================================================
   LEARNING

   After every reply, what the user said is checked for
   anything worth remembering in every future chat (their
   name, work, people, projects, how they like answers).
   The updated memory is sealed and saved like before, and
   a small note under the reply says what was kept, with
   Undo. Everything stays editable in My profile.
===================================================== */

let learning = Promise.resolve();

function learnFromExchange(userText, reply, chatId) {

  learning = learning.then(() => learnNow(userText, reply, chatId)).catch(() => {});

  return learning;

}


async function learnNow(userText, reply, chatId) {

  if (!currentUser && !guestMode) return;

  /* memory we could not open here is never overwritten */
  if (memoryLocked) return;

  /* someone is typing in the profile box, leave it alone */
  if (document.activeElement === memoryTextarea) return;

  let data;

  try {

    const response =
      await fetch(`${API_BASE}/api/memory/learn`, {
        method: 'POST',
        headers: await apiHeaders(),
        body: JSON.stringify({
          memory: memory || '',
          userText,
          reply: String(reply || '').slice(0, 2000)
        })
      });

    data = await response.json();

  } catch {
    return;
  }

  if (!data?.changed || typeof data.memory !== 'string') return;

  if (data.memory.trim() === (memory || '').trim()) return;

  const previous = memory || '';

  memory = data.memory;
  memoryTextarea.value = memory;

  const saved = await saveMemory();

  if (!saved) {
    if (isCurrentChat(chatId)) {
      showLearnedNote([], [], previous, 'I tried to remember that but could not save it. Check your connection.');
    }
    return;
  }

  const added = (data.added || []).filter(Boolean);
  const removed = (data.removed || []).filter(Boolean);

  if (isCurrentChat(chatId) && (added.length || removed.length)) {
    showLearnedNote(added, removed, previous);
  }

}


function showLearnedNote(added, removed, previous, problem = '') {

  const row = document.createElement('div');
  row.className = 'messageRow assistant learnedRow';

  const note = document.createElement('div');
  note.className = 'learnedNote';

  const text = document.createElement('span');
  text.className = 'learnedText';
  text.textContent =
    problem ||
    (added.length
      ? `Remembered: ${added.join('; ')}`
      : `Forgot: ${removed.join('; ')}`);

  if (problem) note.classList.add('problem');

  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'learnedUndo';
  undo.textContent = 'Undo';

  undo.addEventListener('click', async () => {

    memory = previous;
    memoryTextarea.value = memory;

    await saveMemory();

    text.textContent = 'Undone.';
    undo.remove();

  });

  note.appendChild(text);
  if (!problem) note.appendChild(undo);
  row.appendChild(note);

  chat.appendChild(row);

  scrollToBottom();

}


/* =====================================================
   CHAT OPTIONS: RENAME AND EXPORT
===================================================== */

chatMenuButton.addEventListener('click', event => {

  event.stopPropagation();

  chatMenu.classList.toggle('show');

  chatMenuButton.setAttribute('aria-expanded', chatMenu.classList.contains('show') ? 'true' : 'false');
  chatMenuButton.classList.toggle('open', chatMenu.classList.contains('show'));

});

document.addEventListener('click', () => {
  chatMenu.classList.remove('show');
  chatMenuButton.setAttribute('aria-expanded', 'false');
  chatMenuButton.classList.remove('open');
});

chatMenu.addEventListener('click', async event => {

  const button =
    event.target.closest('.chatMenuItem');

  if (!button) return;

  chatMenu.classList.remove('show');
  chatMenuButton.setAttribute('aria-expanded', 'false');
  chatMenuButton.classList.remove('open');

  if (button.dataset.action === 'rename') {
    await renameCurrentChat();
  }

  if (button.dataset.action === 'export') {
    await exportCurrentChat();
  }

});


async function renameCurrentChat() {

  if (!currentChatId) {

    addTextMessage(
      'assistant',
      'Send a message first, then this chat can be renamed.'
    );

    return;

  }

  const current =
    chats.find(
      item => String(item.id) === String(currentChatId)
    );

  const name =
    prompt(
      'Name this chat',
      current?.title || ''
    );

  if (name === null) return;

  const trimmed = name.trim();

  if (!trimmed) return;

  /*
    A name the user chose should not be replaced later by
    the automatic one.
  */
  titledChats.add(String(currentChatId));

  await updateChatTitle(currentChatId, trimmed);

}


async function exportCurrentChat() {

  if (!currentChatId) {

    addTextMessage(
      'assistant',
      'There is nothing to export from an empty chat.'
    );

    return;

  }

  let rows = [];

  if (guestMode) {

    rows = guestMessages(currentChatId);

  } else {

    const { data } =
      await supabaseClient
        .from('messages')
        .select('role,content,image_url,created_at')
        .eq('chat_id', currentChatId)
        .order('created_at', { ascending: true });

    rows =
      await decRows(data, ['content']);

  }

  const title =
    chats.find(
      item => String(item.id) === String(currentChatId)
    )?.title || 'Natter chat';

  const lines = [
    `# ${title}`,
    '',
    `Exported ${new Date().toLocaleString()}`,
    ''
  ];

  rows.forEach(row => {

    lines.push(
      row.role === 'user' ? '## You' : '## Natter'
    );

    if (row.content) {
      lines.push(row.content);
    }

    if (row.image_url) {
      lines.push(
        row.image_url.startsWith('http')
          ? `Image: ${row.image_url}`
          : 'Image: saved in this chat'
      );
    }

    lines.push('');

  });

  const blob =
    new Blob([lines.join('\n')], {
      type: 'text/markdown'
    });

  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');

  link.href = url;

  link.download =
    `${title.replace(/[^\w\s-]/g, '').trim().slice(0, 40) || 'natter-chat'}.md`;

  document.body.appendChild(link);

  link.click();

  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 2000);

}


/* =====================================================
   TRY AGAIN

   Removes this reply and asks the same question once more.
===================================================== */

async function retryReply(row) {

  /*
    Walk back up the chat for the message that prompted it.
  */

  let previous = row.previousElementSibling;

  while (
    previous &&
    !previous.classList.contains('user')
  ) {
    previous = previous.previousElementSibling;
  }

  const question =
    previous
      ? (previous.textContent || '').trim()
      : '';

  if (!question) {

    addTextMessage(
      'assistant',
      'I cannot find the message that this reply answered.'
    );

    return;

  }

  const chatId = currentChatId;

  /* a retry means that answer missed: maybe there is a general lesson in it */
  const missed =
    row.querySelector('.messageBubble')?.dataset.raw ||
    row.querySelector('.messageBubble')?.textContent || '';

  suggestLesson('retry', question, missed);

  row.remove();

  await deleteLastAssistantMessage(chatId);

  sendNormalMessage(question, chatId);

}


/*
  Drops the most recent reply from storage, so a retry
  does not leave two answers behind.
*/
async function deleteLastAssistantMessage(chatId) {

  if (!chatId) return;

  if (guestMode) {

    const stored = guestMessages(chatId);

    for (let i = stored.length - 1; i >= 0; i--) {
      if (stored[i].role === 'assistant') {
        stored.splice(i, 1);
        break;
      }
    }

    saveGuestMessages(chatId, stored);

    return;

  }

  try {

    const { data } =
      await supabaseClient
        .from('messages')
        .select('id')
        .eq('chat_id', chatId)
        .eq('role', 'assistant')
        .order('created_at', { ascending: false })
        .limit(1);

    const last = data?.[0];

    if (last) {

      await supabaseClient
        .from('messages')
        .delete()
        .eq('id', last.id);

    }

  } catch (error) {

    console.error('RETRY CLEANUP ERROR:', error);

  }

}


/* =====================================================
   STREAMED REPLY
===================================================== */

async function streamReply(response, requestChatId) {

  const showing =
    isCurrentChat(requestChatId);

  let bubble = null;

  if (showing) {

    const row =
      addTextMessage('assistant', '');

    bubble = row.querySelector('.messageBubble');

    bubble.classList.add('streaming');

  }


  const reader =
    response.body?.getReader();


  /*
    No streaming support: fall back to the whole body.
  */
  if (!reader) {

    const text = await response.text();

    const data =
      JSON.parse(text || '{}');

    const reply =
      data.reply ||
      'Sorry, I could not generate a response.';

    if (bubble) {
      bubble.classList.remove('streaming');
      bubble.dataset.raw = reply;
      bubble.innerHTML = renderMarkdown(reply);
      settleReplyTools(bubble, reply);
    }

    return reply;

  }


  const decoder = new TextDecoder();

  let buffer = '';
  let reply = '';
  let lastDrawn = 0;

  while (true) {

    const { value, done } = await reader.read();

    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');

    // keep the last, possibly incomplete, line
    buffer = lines.pop() || '';

    for (const line of lines) {

      if (!line.startsWith('data: ')) continue;

      const payload = line.slice(6).trim();

      if (!payload || payload === '[DONE]') continue;

      let parsed;

      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      if (parsed.error) {
        throw new Error(parsed.error);
      }

      /* checking the live web before answering */
      if (parsed.status === 'searching' && bubble && !reply) {

        bubble.innerHTML =
          '<span class="webSearching"><span class="webSearchingDot"></span>Searching the web</span>';

        scrollToBottom();

      }

      if (parsed.text) {

        reply += parsed.text;

        /*
          Redraw at most every few characters, so long
          replies do not thrash the layout.
        */
        if (bubble && reply.length - lastDrawn > 12) {

          lastDrawn = reply.length;

          bubble.innerHTML = renderMarkdown(reply);

          scrollToBottom();

        }

      }

    }

  }


  if (bubble) {

    bubble.classList.remove('streaming');

    bubble.dataset.raw = reply || '';

    bubble.innerHTML =
      renderMarkdown(
        reply || 'Sorry, I could not generate a response.'
      );

    settleReplyTools(bubble, reply);

    scrollToBottom();

  }


  return (
    reply ||
    'Sorry, I could not generate a response.'
  );

}


/* =====================================================
   NORMAL CHAT
===================================================== */

async function sendNormalMessage(
  text,
  requestChatId,
  image = null,
  images = null
) {

  const jobId =
    startJob(
      requestChatId,
      'Natter is replying...'
    );


  replyController = new AbortController();

  stopButton.classList.add('show');


  try {

    let messages;


    if (guestMode) {

      messages =
        guestMessages(requestChatId)
          .filter(item => !item.image_url)
          .map(item => ({
            role: item.role,
            content: item.content || ''
          }))
          .slice(-30);

    } else {

    const {
      data: messageRows,
      error
    } =
      await supabaseClient
        .from('messages')
        .select(
          'role,content'
        )
        .eq(
          'chat_id',
          requestChatId
        )
        .eq(
          'user_id',
          currentUser.id
        )
        .order(
          'created_at',
          {
            ascending: true
          }
        );


    if (error) {
      throw error;
    }


    const clearRows =
      await decRows(messageRows, ['content']);

    messages =
      clearRows
        .filter(item => !item.__locked)
        .map(
          item => ({
            role:
              item.role,

            content:
              item.content || ''
          })
        )
        .slice(-30);

    }


    const response =
      await fetch(
        `${API_BASE}/api/chat`,
        {

          method:
            'POST',

          headers:
            await apiHeaders(),

          signal:
            replyController.signal,

          body:
            JSON.stringify({

              messages,

              memory,

              image,

              images,

              mode: chatMode,

              stream: true

            })

        }
      );


    if (!response.ok) {

      let message = 'Chat request failed.';

      try {
        const failed = await response.json();
        message =
          failed?.details ||
          failed?.error ||
          message;
      } catch {}

      throw new Error(message);

    }


    /*
      STREAMING

      The reply is drawn as it arrives, in the chat it
      belongs to. If the user is reading another chat it
      is saved quietly and shown when they come back.
    */

    const reply =
      await streamReply(
        response,
        requestChatId
      );


    await saveMessage(
      'assistant',
      reply,
      null,
      requestChatId
    );


    nameChatFromContent(requestChatId);

    /* quietly learn anything worth keeping for next time */
    learnFromExchange(text, reply, requestChatId);


  } catch (error) {

    /*
      The user pressed Stop. Whatever arrived before that
      is already drawn, so there is nothing to apologise for.
    */

    if (error?.name === 'AbortError') {
      return;
    }


    console.error(
      'CHAT ERROR:',
      error
    );


    const failure =
      `Sorry, something went wrong:\n${error.message}`;

    addTextMessageTo(
      requestChatId,
      'assistant',
      failure
    );

    await saveMessage(
      'assistant',
      failure,
      null,
      requestChatId
    );

  } finally {

    replyController = null;

    stopButton.classList.remove('show');

    endJob(jobId);

  }

}


/* =====================================================
   NAME THE CHAT FROM ITS CONTENT

   The first message makes a rough title. Once there is
   a real exchange, the model is asked for a short title
   describing what the chat is actually about.
===================================================== */

const titledChats = new Set();

async function nameChatFromContent(chatId) {

  if (!chatId || titledChats.has(String(chatId))) {
    return;
  }

  titledChats.add(String(chatId));


  try {

    let history;


    if (guestMode) {

      history =
        guestMessages(chatId)
          .filter(item => !item.image_url)
          .map(item => ({
            role: item.role,
            content: item.content || ''
          }));

    } else {

      const { data } =
        await supabaseClient
          .from('messages')
          .select('role,content')
          .eq('chat_id', chatId)
          .eq('user_id', currentUser.id)
          .order('created_at', { ascending: true });

      const clear =
        await decRows(data, ['content']);

      history =
        clear.filter(item => !item.__locked).map(item => ({
          role: item.role,
          content: item.content || ''
        }));

    }


    const conversation =
      history
        .slice(0, 6)
        .map(item =>
          `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.content}`
        )
        .join('\n')
        .slice(0, 2000);


    if (!conversation.trim()) {
      titledChats.delete(String(chatId));
      return;
    }


    const response =
      await fetch(
        `${API_BASE}/api/chat`,
        {
          method: 'POST',
          headers: await apiHeaders(),
          body: JSON.stringify({
            messages: [
              {
                role: 'user',
                content:
                  'Read this conversation and reply with a title of ' +
                  'two to five words describing what it is about. ' +
                  'Reply with the title only, no quotes, no full stop.' +
                  '\n\n' + conversation
              }
            ]
          })
        }
      );


    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error || 'Title request failed.');
    }


    const title =
      (data?.reply || '')
        .replace(/["'`]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 55);


    if (title) {

      await updateChatTitle(chatId, title);

    }


  } catch (error) {

    console.error('TITLE ERROR:', error);

    // let a later message try again
    titledChats.delete(String(chatId));

  }

}


/* =====================================================
   SEND MESSAGE
===================================================== */

async function sendMessage() {

  const userText =
    messageInput.value.trim();


  if (
    !userText ||
    (!currentUser && !guestMode)
  ) {

    return;

  }


  /*
    Capture the current chat before
    anything asynchronous happens.
  */

  const requestChatId =
    await ensureChat(
      userText
    );


  /*
    A question about an attached photo is shown and saved
    once, as the photo with the words under it, further
    down. Everything else shows the words here.
  */
  const askingAboutPhoto =
    Boolean(selectedImageData) &&
    !videoMode &&
    (photoActionChosen ? photoAction : guessPhotoAction(userText)) === 'ask';

  if (!askingAboutPhoto) {

    addTextMessage(
      'user',
      userText
    );

    await saveMessage(
      'user',
      userText,
      null,
      requestChatId
    );

  }


  /*
    -----------------------------------------------------
    VIDEO MODE (an attached photo becomes the first frame)
    -----------------------------------------------------
  */

  if (videoMode) {

    const firstFrame = selectedImageData || null;

    if (firstFrame) {
      recordUpload(firstFrame, 'video');
      clearUpload();
    }

    messageInput.value = '';

    resizeTextarea();

    setVideoMode(false);

    generateVideo(userText, requestChatId, firstFrame);

    return;

  }


  /*
    -----------------------------------------------------
    UPLOADED IMAGE EDIT
    -----------------------------------------------------
  */

  if (selectedImageData) {

    if (guestImagesBlocked()) {

      clearUpload();

      return;

    }

    const photos =
      selectedImages.map(item => item.data);

    const image =
      photos[0];

    const rest =
      photos.slice(1);

    const action =
      photoActionChosen ? photoAction : guessPhotoAction(userText);


    clearUpload();


    messageInput.value =
      '';

    resizeTextarea();


    /*
      ASK ABOUT IT

      The photo goes with the question, so Natter can
      answer about what is in it instead of editing it.
    */

    if (action === 'ask') {

      for (const [index, photo] of photos.entries()) {

        const storedUrl =
          await storeImage(photo);

        recordUpload(photo, 'ask', storedUrl);

        addUserImage(
          requestChatId,
          photo,
          index === photos.length - 1 ? userText : ''
        );

        await saveMessage(
          'user',
          index === photos.length - 1 ? userText : '',
          storedUrl,
          requestChatId
        );

      }

      sendNormalMessage(
        userText,
        requestChatId,
        image,
        rest
      );

      return;

    }


    photos.forEach(photo => recordUpload(photo, 'edit'));

    editImage(
      image,
      userText,
      requestChatId,
      false,
      null,
      true,
      rest
    ).catch(async error => {

      console.error(
        'UPLOAD EDIT ERROR:',
        error
      );


      const failure =
        `Could not edit the image:\n${friendlyMediaError(error.message, 'image')}`;

      addTextMessageTo(
        requestChatId,
        'assistant',
        failure
      );

      await saveMessage(
        'assistant',
        failure,
        null,
        requestChatId
      );

      offerFittingVersion(requestChatId, userText, 'edit', error.message);

    });


    return;

  }


  /*
    -----------------------------------------------------
    IMAGE GENERATION MODE
    -----------------------------------------------------
  */

  if (imageMode) {

    messageInput.value =
      '';

    resizeTextarea();

    setImageMode(false);

    if (guestImagesBlocked()) {
      return;
    }


    generateImage(
      userText,
      requestChatId
    );


    return;

  }


  /*
    -----------------------------------------------------
    NORMAL CHAT
    -----------------------------------------------------
  */

  messageInput.value =
    '';

  resizeTextarea();


  sendNormalMessage(
    userText,
    requestChatId
  );

}


/* =====================================================
   VOICE CONVERSATION

   A live call with Natter through OpenAI's Realtime API.
   The server hands over a short lived key; the browser
   then talks to OpenAI directly over WebRTC, so audio
   never passes through our server. What each side says
   comes back as text and is saved to the chat, sealed like
   any other message. Admins only while it is tested.
===================================================== */

const voiceScreen = document.getElementById('voiceScreen');
const voiceStatus = document.getElementById('voiceStatus');
const voiceTranscript = document.getElementById('voiceTranscript');
const voiceMute = document.getElementById('voiceMute');

let voiceCall = null;


function setVoiceState(state, label) {

  voiceScreen.classList.toggle('listening', state === 'listening');
  voiceScreen.classList.toggle('speaking', state === 'speaking');

  voiceStatus.textContent = label;

}


function addVoiceLine(role, text) {

  const line = document.createElement('div');
  line.className = `voiceLine ${role}`;
  line.textContent = text;

  voiceTranscript.appendChild(line);
  voiceTranscript.scrollTop = voiceTranscript.scrollHeight;

}


/* each finished line goes into the chat straight away, so hanging up loses nothing */
async function keepVoiceLine(role, text) {

  const clean = String(text || '').trim();

  if (!clean || !voiceCall) return;

  addVoiceLine(role, clean);

  const call = voiceCall;

  call.saving = call.saving.then(async () => {

    try {

      if (!call.chatId) {
        call.chatId = await ensureChat(role === 'user' ? clean : 'Voice chat');
      }

      addTextMessageTo(call.chatId, role, clean);

      await saveMessage(role, clean, null, call.chatId);

      if (role === 'user') {
        learnFromExchange(clean, '', call.chatId);
      }

    } catch (error) {
      console.error('VOICE SAVE ERROR:', error);
    }

  });

}


function recentChatText() {

  return [...document.querySelectorAll('#chat .messageRow:not(.learnedRow)')]
    .slice(-12)
    .map(row => {
      const who = row.classList.contains('user') ? 'User' : 'Natter';
      const text = (row.querySelector('.messageBubble, .bubble')?.innerText || row.innerText || '').trim();
      return text ? `${who}: ${text.slice(0, 300)}` : '';
    })
    .filter(Boolean)
    .join('\n');

}


async function startVoiceCall() {

  if (voiceCall) return;

  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    addTextMessage('assistant', 'Voice chat needs a browser with microphone support.');
    return;
  }

  voiceTranscript.innerHTML = '';
  voiceMute.textContent = 'Mute';
  voiceMute.classList.remove('muted');
  setVoiceState('connecting', 'Connecting...');
  voiceScreen.classList.add('show');

  voiceCall = {
    pc: null,
    stream: null,
    audio: null,
    channel: null,
    chatId: currentChatId || null,
    saving: Promise.resolve(),
    muted: false
  };

  const call = voiceCall;

  try {

    const stream =
      await navigator.mediaDevices.getUserMedia({ audio: true });

    call.stream = stream;

    if (voiceCall !== call) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    const started =
      await fetch(`${API_BASE}/api/voice/session`, {
        method: 'POST',
        headers: await apiHeaders(),
        body: JSON.stringify({
          memory: typeof memory === 'string' ? memory : '',
          recent: recentChatText()
        })
      });

    const session = await started.json().catch(() => ({}));

    if (!started.ok || !session.key) {
      throw new Error(session.error || 'The call could not be started.');
    }

    const pc = new RTCPeerConnection();

    call.pc = pc;

    const audio = document.createElement('audio');
    audio.autoplay = true;
    call.audio = audio;

    pc.ontrack = event => {
      audio.srcObject = event.streams[0];
    };

    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    const channel = pc.createDataChannel('oai-events');

    call.channel = channel;

    channel.addEventListener('open', () => {
      setVoiceState('listening', 'Listening');
    });

    channel.addEventListener('message', event => {

      let data;

      try { data = JSON.parse(event.data); } catch { return; }

      switch (data.type) {

        case 'input_audio_buffer.speech_started':
          setVoiceState('listening', 'Listening');
          break;

        case 'conversation.item.input_audio_transcription.completed':
          keepVoiceLine('user', data.transcript);
          break;

        case 'response.output_audio.delta':
        case 'response.audio.delta':
        case 'response.output_audio_transcript.delta':
        case 'response.audio_transcript.delta':
          setVoiceState('speaking', 'Natter is talking');
          break;

        case 'response.output_audio_transcript.done':
        case 'response.audio_transcript.done':
          keepVoiceLine('assistant', data.transcript);
          break;

        case 'response.done':
          setVoiceState('listening', 'Listening');
          break;

        case 'error':
          console.error('VOICE EVENT ERROR:', data.error);
          break;

      }

    });

    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'disconnected'].includes(pc.connectionState) && voiceCall === call) {
        setVoiceState('connecting', 'The line dropped. End the call and try again.');
      }
    });

    const offer = await pc.createOffer();

    await pc.setLocalDescription(offer);

    const answer =
      await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${session.key}`,
          'Content-Type': 'application/sdp'
        }
      });

    if (!answer.ok) {
      throw new Error(`The voice service refused the call (${answer.status}).`);
    }

    await pc.setRemoteDescription({ type: 'answer', sdp: await answer.text() });

  } catch (error) {

    console.error('VOICE START ERROR:', error);

    const message =
      error?.name === 'NotAllowedError'
        ? 'Natter needs permission to use your microphone. Allow it in your browser and try again.'
        : (error?.message || 'The call could not be started.');

    endVoiceCall();

    addTextMessage('assistant', message);

  }

}


function endVoiceCall() {

  const call = voiceCall;

  voiceCall = null;

  voiceScreen.classList.remove('show', 'listening', 'speaking');

  if (!call) return;

  try { call.channel?.close(); } catch {}
  try { call.pc?.close(); } catch {}

  call.stream?.getTracks().forEach(track => track.stop());

  if (call.audio) call.audio.srcObject = null;

  /* the chat list picks up a chat the call started */
  call.saving.then(() => {
    if (call.chatId && typeof loadChats === 'function') loadChats();
  });

}


document.getElementById('voiceButton')?.addEventListener('click', startVoiceCall);
document.getElementById('voiceClose')?.addEventListener('click', endVoiceCall);
document.getElementById('voiceEnd')?.addEventListener('click', endVoiceCall);

voiceMute?.addEventListener('click', () => {

  if (!voiceCall?.stream) return;

  voiceCall.muted = !voiceCall.muted;

  voiceCall.stream.getAudioTracks().forEach(track => { track.enabled = !voiceCall.muted; });

  voiceMute.textContent = voiceCall.muted ? 'Unmute' : 'Mute';
  voiceMute.classList.toggle('muted', voiceCall.muted);

  setVoiceState('listening', voiceCall.muted ? 'Muted' : 'Listening');

});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && voiceCall) endVoiceCall();
});


/* =====================================================
   PEEKING ROBOT

   Ten little routines. Each one rises from behind the top
   edge of the message box, has a look, and hides again.
   He shows up now and then, never while you are typing,
   and not at all if the device asks for less motion.
===================================================== */

const PEEK_SVG = `
<svg viewBox="0 0 64 60" aria-hidden="true">
  <defs>
    <linearGradient id="peekHead" x1="0" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#6cc8ff"/>
      <stop offset="1" stop-color="#2a5fe6"/>
    </linearGradient>
    <linearGradient id="peekEar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4aa6ff"/>
      <stop offset="1" stop-color="#2248c9"/>
    </linearGradient>
  </defs>
  <g class="body">
    <rect class="neck" x="27" y="52" width="10" height="8" rx="3" fill="#2248c9"/>
    <g class="armL">
      <rect class="limb" x="9" y="60" width="7" height="20" rx="3.5" fill="url(#peekEar)" transform="rotate(12 12.5 62)"/>
      <circle class="mitt" cx="8.8" cy="81" r="4.6" fill="#58b6ff"/>
    </g>
    <g class="armR">
      <rect class="limb" x="48" y="60" width="7" height="20" rx="3.5" fill="url(#peekEar)" transform="rotate(-12 51.5 62)"/>
      <circle class="mitt" cx="55.2" cy="81" r="4.6" fill="#58b6ff"/>
    </g>
    <rect class="leg" x="20" y="84" width="9" height="15" rx="4" fill="url(#peekEar)"/>
    <rect class="leg" x="35" y="84" width="9" height="15" rx="4" fill="url(#peekEar)"/>
    <ellipse class="foot" cx="24" cy="100.5" rx="7" ry="3.5" fill="#2248c9"/>
    <ellipse class="foot" cx="40" cy="100.5" rx="7" ry="3.5" fill="#2248c9"/>
    <rect class="torso" x="15" y="57" width="34" height="30" rx="11" fill="url(#peekHead)"/>
    <rect class="chest" x="23" y="63" width="18" height="12" rx="4" fill="#05060d"/>
    <circle class="light" cx="32" cy="69" r="2.6" fill="#9fe6ff"/>
  </g>
  <g class="antenna">
    <path class="stem" d="M38 16 L40.5 6" stroke="#5ab8ff" stroke-width="3" stroke-linecap="round"/>
    <circle class="ball" cx="41" cy="5" r="4.2" fill="#8fdcff"/>
    <circle cx="39.8" cy="3.8" r="1.3" fill="#e6f8ff"/>
  </g>
  <rect class="ear" x="2.5" y="26" width="8" height="18" rx="4" fill="url(#peekEar)"/>
  <rect class="ear" x="53.5" y="26" width="8" height="18" rx="4" fill="url(#peekEar)"/>
  <rect class="head" x="7" y="14" width="50" height="42" rx="16" fill="url(#peekHead)"/>
  <rect class="rim" x="8.5" y="15.5" width="47" height="39" rx="14.5" fill="none" stroke="#bfe9ff" stroke-opacity=".45" stroke-width="1.2"/>
  <rect class="visor" x="12" y="19.5" width="40" height="31" rx="12" fill="#05060d"/>
  <g class="eyes">
    <path class="eyeHappy left" d="M19.5 38 q5 -7 10 0" fill="none" stroke="#3fb8ff" stroke-opacity=".35" stroke-width="5.5" stroke-linecap="round"/>
    <path class="eyeHappy left" d="M19.5 38 q5 -7 10 0" fill="none" stroke="#9fe6ff" stroke-width="3" stroke-linecap="round"/>
    <path class="eyeHappy right" d="M34.5 38 q5 -7 10 0" fill="none" stroke="#3fb8ff" stroke-opacity=".35" stroke-width="5.5" stroke-linecap="round"/>
    <path class="eyeHappy right" d="M34.5 38 q5 -7 10 0" fill="none" stroke="#9fe6ff" stroke-width="3" stroke-linecap="round"/>
    <path class="eyeWink" d="M34.5 36 h10" fill="none" stroke="#9fe6ff" stroke-width="3" stroke-linecap="round"/>
    <circle class="eyeOpen" cx="24.5" cy="35" r="4" fill="#9fe6ff"/>
    <circle class="eyeOpen" cx="39.5" cy="35" r="4" fill="#9fe6ff"/>
  </g>
</svg>`;

/* how far up he comes: hidden, eyes just over the edge, most of his face */
const PEEK_HIDDEN = 110;
const PEEK_EYES = 28;
/* standing right up on the edge, body and all */
const PEEK_HIGH = -73;

const PEEK_HAND_SVG = `
<svg viewBox="0 0 18 30" aria-hidden="true">
  <rect x="6" y="11" width="6" height="19" rx="3" fill="#2f6fe8"/>
  <circle cx="9" cy="8.5" r="7" fill="#58b6ff"/>
  <ellipse cx="3.2" cy="10.5" rx="2.4" ry="3.2" fill="#4aa6ff"/>
  <circle cx="7" cy="6" r="2" fill="#bfe9ff" fill-opacity=".55"/>
</svg>`;

function peekPose(y, extra = '') {
  return { transform: `translateY(${y}%) ${extra}`.trim() };
}

const peekRoutines = [

  /* 1. a quick look and a blink */
  async bot => {
    await bot.move([peekPose(PEEK_HIDDEN), peekPose(PEEK_EYES)], 520, 'cubic-bezier(.2,.8,.3,1)');
    await bot.wait(500);
    await bot.blink();
    await bot.wait(500);
    await bot.move([peekPose(PEEK_EYES), peekPose(PEEK_HIDDEN)], 380, 'ease-in');
  },

  /* 2. peek and blink */
  async bot => {
    await bot.move([peekPose(PEEK_HIDDEN), peekPose(PEEK_EYES)], 560, 'cubic-bezier(.2,.8,.3,1)');
    await bot.wait(500);
    await bot.blink();
    await bot.wait(350);
    await bot.blink();
    await bot.wait(450);
    await bot.move([peekPose(PEEK_EYES), peekPose(PEEK_HIDDEN)], 400, 'ease-in');
  },

  /* 3. looks left, then right */
  async bot => {
    await bot.move([peekPose(PEEK_HIDDEN), peekPose(PEEK_EYES)], 560, 'cubic-bezier(.2,.8,.3,1)');
    await bot.look(-3.5);
    await bot.wait(650);
    await bot.look(3.5);
    await bot.wait(650);
    await bot.look(0);
    await bot.blink();
    await bot.wait(200);
    await bot.move([peekPose(PEEK_EYES), peekPose(PEEK_HIDDEN)], 380, 'ease-in');
  },

  /* 4. pops up high and gives a big wave */
  async bot => {
    await bot.move([peekPose(PEEK_HIDDEN), peekPose(PEEK_HIGH)], 560, 'cubic-bezier(.2,.8,.3,1)');
    await bot.wave(3);
    await bot.blink();
    await bot.wait(250);
    await bot.move([peekPose(PEEK_HIGH), peekPose(PEEK_HIDDEN)], 420, 'ease-in');
  },

  /* 5. antenna first, a wiggle, then the face */
  async bot => {
    await bot.move([peekPose(PEEK_HIDDEN), peekPose(66)], 450, 'ease-out');
    await bot.wiggle();
    await bot.move([peekPose(66), peekPose(PEEK_EYES)], 380, 'cubic-bezier(.2,.8,.3,1)');
    await bot.wait(350);
    await bot.blink();
    await bot.wait(350);
    await bot.move([peekPose(PEEK_EYES), peekPose(PEEK_HIDDEN)], 380, 'ease-in');
  },

  /* 6. the tilt from the logo, then the other way */
  async bot => {
    await bot.move([peekPose(PEEK_HIDDEN, 'rotate(12deg)'), peekPose(PEEK_EYES, 'rotate(12deg)')], 560, 'cubic-bezier(.2,.8,.3,1)');
    await bot.wait(500);
    await bot.move([peekPose(PEEK_EYES, 'rotate(12deg)'), peekPose(PEEK_EYES, 'rotate(-12deg)')], 520, 'ease-in-out');
    await bot.blink();
    await bot.wait(350);
    await bot.move([peekPose(PEEK_EYES, 'rotate(-12deg)'), peekPose(PEEK_HIDDEN, 'rotate(0deg)')], 420, 'ease-in');
  },

  /* 7. spotted! eyes go wide and he ducks */
  async bot => {
    await bot.move([peekPose(PEEK_HIDDEN), peekPose(PEEK_EYES)], 700, 'ease-out');
    await bot.wait(500);
    bot.eyes('open');
    await bot.wait(380);
    await bot.move([peekPose(PEEK_EYES), peekPose(PEEK_HIDDEN)], 180, 'ease-in');
    bot.eyes('happy');
  },

  /* 8. a double take */
  async bot => {
    await bot.move([peekPose(PEEK_HIDDEN), peekPose(PEEK_EYES)], 450, 'cubic-bezier(.2,.8,.3,1)');
    await bot.wait(300);
    await bot.move([peekPose(PEEK_EYES), peekPose(PEEK_HIDDEN)], 260, 'ease-in');
    await bot.wait(350);
    bot.eyes('open');
    await bot.move([peekPose(PEEK_HIDDEN), peekPose(PEEK_HIGH)], 280, 'cubic-bezier(.3,1.4,.5,1)');
    await bot.wait(700);
    bot.eyes('happy');
    await bot.wait(300);
    await bot.move([peekPose(PEEK_HIGH), peekPose(PEEK_HIDDEN)], 420, 'ease-in');
  },

  /* 9. pops up in one place, then another, and waves */
  async bot => {
    bot.place('left');
    await bot.move([peekPose(PEEK_HIDDEN), peekPose(PEEK_EYES)], 420, 'cubic-bezier(.2,.8,.3,1)');
    await bot.wait(550);
    await bot.move([peekPose(PEEK_EYES), peekPose(PEEK_HIDDEN)], 300, 'ease-in');
    await bot.wait(300);
    bot.place('middle');
    await bot.move([peekPose(PEEK_HIDDEN), peekPose(PEEK_EYES)], 420, 'cubic-bezier(.2,.8,.3,1)');
    await bot.wave(2);
    await bot.move([peekPose(PEEK_EYES), peekPose(PEEK_HIDDEN)], 360, 'ease-in');
  },

  /* 10. a cheeky wink and a wave */
  async bot => {
    await bot.move([peekPose(PEEK_HIDDEN), peekPose(PEEK_HIGH)], 620, 'cubic-bezier(.2,.8,.3,1)');
    await bot.wait(450);
    bot.eyes('wink');
    await bot.wave(2);
    bot.eyes('happy');
    await bot.wait(250);
    await bot.move([peekPose(PEEK_HIGH), peekPose(PEEK_HIDDEN)], 420, 'ease-in');
  },

  /* 11. walks down a flight of stairs, a step at a time */
  async bot => {
    bot.place('left');
    await bot.move([peekPose(PEEK_HIDDEN), peekPose(PEEK_HIGH)], 380, 'cubic-bezier(.2,.8,.3,1)');
    await bot.wait(250);
    let y = PEEK_HIGH;
    let x = 0;
    for (let step = 0; step < 8; step += 1) {
      const nextY = y + 23;
      const tilt = step % 2 ? 6 : -6;
      await Promise.all([
        bot.travel(x, x + 22, 300, 'linear'),
        bot.move([peekPose(y, 'rotate(0deg)'), peekPose(y - 3, `rotate(${tilt}deg)`), peekPose(nextY, 'rotate(0deg)')], 300, 'ease-in')
      ]);
      x += 22;
      y = nextY;
    }
    await bot.move([peekPose(y), peekPose(PEEK_HIDDEN)], 150, 'ease-in');
  },

  /* 12. climbs up the stairs, has a look, slides back down */
  async bot => {
    bot.place('left');
    let y = PEEK_HIDDEN;
    let x = 0;
    for (let step = 0; step < 8; step += 1) {
      const nextY = Math.max(PEEK_HIGH, y - 23);
      const tilt = step % 2 ? 7 : -7;
      await Promise.all([
        bot.travel(x, x + 20, 320, 'linear'),
        bot.move([peekPose(y, 'rotate(0deg)'), peekPose(nextY - 4, `rotate(${tilt}deg)`), peekPose(nextY, 'rotate(0deg)')], 320, 'ease-out')
      ]);
      x += 20;
      y = nextY;
    }
    await bot.wait(250);
    await bot.look(-3.5);
    await bot.wait(400);
    await bot.look(0);
    await bot.blink();
    bot.eyes('open');
    await Promise.all([
      bot.travel(x, x - 60, 420, 'ease-in'),
      bot.move([peekPose(y), peekPose(PEEK_HIDDEN)], 420, 'ease-in')
    ]);
  },

  /* 13. takes the lift: dead straight up, ding, doors, straight down */
  async bot => {
    bot.place('middle');
    await bot.move([peekPose(PEEK_HIDDEN), peekPose(PEEK_HIGH)], 1500, 'linear');
    await bot.move([peekPose(PEEK_HIGH), peekPose(PEEK_HIGH + 3), peekPose(PEEK_HIGH)], 220, 'ease-out');
    await bot.ding();
    await bot.wait(300);
    await bot.look(3.5);
    await bot.wait(450);
    await bot.look(-3.5);
    await bot.wait(450);
    await bot.look(0);
    await bot.ding();
    await bot.move([peekPose(PEEK_HIGH), peekPose(PEEK_HIDDEN)], 1400, 'linear');
  },

  /* 14. rides an escalator, perfectly still, up and across, then down the other side */
  async bot => {
    bot.place('left');
    await Promise.all([
      bot.travel(0, 110, 1600, 'linear'),
      bot.move([peekPose(PEEK_HIDDEN), peekPose(PEEK_HIGH)], 1600, 'linear')
    ]);
    await bot.wait(300);
    await bot.blink();
    await bot.wait(250);
    await Promise.all([
      bot.travel(110, 220, 1600, 'linear'),
      bot.move([peekPose(PEEK_HIGH), peekPose(PEEK_HIDDEN)], 1600, 'linear')
    ]);
  },

  /* 15. on a trampoline: boing, boing, flip */
  async bot => {
    bot.place('middle');
    const bounce = async (top, ms) => {
      await bot.move([peekPose(PEEK_HIDDEN), peekPose(top)], ms, 'cubic-bezier(.2,.9,.4,1)');
      await bot.move([peekPose(top), peekPose(PEEK_HIDDEN)], ms, 'cubic-bezier(.6,0,.8,.1)');
    };
    await bounce(60, 260);
    await bounce(30, 300);
    bot.eyes('open');
    await bot.move([
      { transform: `translateY(${PEEK_HIDDEN}%) rotate(0deg)`, transformOrigin: '50% 50%' },
      { transform: `translateY(${PEEK_HIGH - 30}%) rotate(180deg)`, transformOrigin: '50% 50%' },
      { transform: `translateY(${PEEK_HIDDEN}%) rotate(360deg)`, transformOrigin: '50% 50%' }
    ], 820, 'ease-in-out');
    bot.eyes('happy');
    await bot.wait(200);
    await bot.move([peekPose(PEEK_HIDDEN), peekPose(PEEK_EYES)], 300, 'cubic-bezier(.2,.8,.3,1)');
    await bot.wait(350);
    await bot.move([peekPose(PEEK_EYES), peekPose(PEEK_HIDDEN)], 300, 'ease-in');
  },

  /* 16. periscope: only the antenna glides along, then he pops up at the end */
  async bot => {
    bot.place('left');
    await bot.move([peekPose(PEEK_HIDDEN), peekPose(76)], 400, 'ease-out');
    await Promise.all([
      bot.travel(0, 200, 2200, 'ease-in-out'),
      bot.wiggle(),
      bot.move([peekPose(76), peekPose(72), peekPose(77), peekPose(72), peekPose(76)], 2200, 'ease-in-out')
    ]);
    await bot.move([peekPose(76), peekPose(PEEK_EYES)], 200, 'cubic-bezier(.3,1.4,.5,1)');
    bot.eyes('open');
    await bot.wait(450);
    bot.eyes('happy');
    await bot.wave(1);
    await bot.move([peekPose(PEEK_EYES), peekPose(PEEK_HIDDEN)], 300, 'ease-in');
  }

];


/* =====================================================
   HALLOWEEN COSTUMES

   One for every routine, in the same order. Only worn when
   the site theme is Halloween. Drawn in the robot's own
   units (his head runs 7 to 57 across and 14 to 56 down),
   so anything beside him moves with him.
===================================================== */

const PEEK_SKELETON_HAND_SVG = `
<svg viewBox="0 0 18 30" aria-hidden="true">
  <rect x="7.6" y="13" width="2.8" height="17" rx="1.4" fill="#efe9dc"/>
  <circle cx="9" cy="13.5" r="2.2" fill="#efe9dc"/>
  <rect x="4.6" y="7.5" width="8.8" height="5.5" rx="2" fill="#efe9dc"/>
  <path d="M5.8 8 V2.8 M8.4 7.6 V1.2 M11 7.6 V1.8 M13.2 8.8 V4.2 M4.8 11 L1.8 8.2" stroke="#efe9dc" stroke-width="1.8" stroke-linecap="round" fill="none"/>
  <path d="M5.8 5.2 h0.01 M8.4 4.2 h0.01 M11 4.6 h0.01" stroke="#8d8573" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

/* =====================================================
   THE DEVIL'S TEN

   The horned costume gets its own ten routines, each with a
   different bad guy. They play in a shuffled order, all ten
   before any repeat, and in Halloween the devil turns up
   half as often again as any other routine.
===================================================== */

const PEEK_ACTORS = {

  thief: `
<svg viewBox="0 0 40 40" aria-hidden="true">
  <path d="M8 40 L8 22 Q8 7 20 7 Q32 7 32 22 L32 40 Z" fill="#2a1640" stroke="#7a4bd6" stroke-opacity=".7" stroke-width="1"/>
  <path d="M13 9 L11 1 L17 7 Z M27 9 L29 1 L23 7 Z" fill="#2a1640"/>
  <rect x="7" y="16" width="26" height="8" rx="4" fill="#05060d"/>
  <path d="M7 20 L2 17 M7 20 L2 23" stroke="#05060d" stroke-width="2" stroke-linecap="round"/>
  <circle cx="15" cy="20" r="2.2" fill="#fff"/><circle cx="25" cy="20" r="2.2" fill="#fff"/>
  <circle cx="15.6" cy="20.2" r="1" fill="#05060d"/><circle cx="25.6" cy="20.2" r="1" fill="#05060d"/>
  <path d="M16 29 q4 2.5 8 0" stroke="#e9e4f5" stroke-width="1.4" fill="none" stroke-linecap="round"/>
  <path d="M33 25 q5 -2 6 3" stroke="#6d5a3f" stroke-width="1.4" fill="none"/>
  <ellipse cx="36" cy="33" rx="4.2" ry="3.6" fill="#ff8a1f"/>
  <path d="M34.3 32.5 l.9 -1.1 l.9 1.1 Z M36.8 32.5 l.9 -1.1 l.9 1.1 Z" fill="#2a1640"/>
</svg>`,

  bat: `
<svg viewBox="0 0 40 20" aria-hidden="true">
  <path d="M20 8 Q14 1 6 3 Q8 6 2 8 Q7 9 6 13 Q12 10 16 14 Q18 10 20 12 Q22 10 24 14 Q28 10 34 13 Q33 9 38 8 Q32 6 34 3 Q26 1 20 8 Z" fill="#140b20" stroke="#7a4bd6" stroke-opacity=".8" stroke-width=".7"/>
  <circle cx="18.5" cy="8.5" r=".9" fill="#ff4d4d"/><circle cx="21.5" cy="8.5" r=".9" fill="#ff4d4d"/>
</svg>`,

  ghost: `
<svg viewBox="0 0 24 30" aria-hidden="true">
  <path d="M1 29 L1 12 Q1 1 12 1 Q23 1 23 12 L23 29 l-3.7 -4 l-3.7 4 l-3.6 -4 l-3.6 4 l-3.7 -4 Z" fill="#f4f1ff"/>
  <ellipse cx="8" cy="12" rx="1.9" ry="2.6" fill="#1a1226"/><ellipse cx="16" cy="12" rx="1.9" ry="2.6" fill="#1a1226"/>
  <ellipse cx="12" cy="19" rx="2.4" ry="3" fill="#1a1226"/>
</svg>`,

  zombie: `
<svg viewBox="0 0 18 30" aria-hidden="true">
  <rect x="5.5" y="12" width="7" height="18" rx="2" fill="#5f8f3e"/>
  <path d="M5.5 22 h7 M5.5 26 h7" stroke="#3e6327" stroke-width="1"/>
  <rect x="3.5" y="7" width="11" height="7" rx="2.5" fill="#79ad4f"/>
  <path d="M5 8 V2 M8 7.5 V.8 M11 7.5 V1.6 M13.5 8.6 V4 M4 11 L1 8" stroke="#79ad4f" stroke-width="2.2" stroke-linecap="round"/>
  <path d="M8 3 h.01 M11 3.6 h.01" stroke="#3e6327" stroke-width="1.2" stroke-linecap="round"/>
</svg>`,

  witch: `
<svg viewBox="0 0 50 30" aria-hidden="true">
  <path d="M2 22 L40 20" stroke="#8a5a2b" stroke-width="2" stroke-linecap="round"/>
  <path d="M40 18 L49 15 L49 26 L40 23 Z" fill="#d9a441"/>
  <path d="M16 21 L22 8 L30 21 Z" fill="#1b1328"/>
  <circle cx="20" cy="10" r="4" fill="#79ad4f"/>
  <path d="M15 7 L27 6 L22 5 L25 -3 L18 4 Z" fill="#1b1328"/>
  <circle cx="18.6" cy="9.6" r=".8" fill="#ffe066"/>
  <path d="M16 11 l-3 1.5" stroke="#79ad4f" stroke-width="1.6" stroke-linecap="round"/>
</svg>`,

  spider: `
<svg viewBox="0 0 20 60" aria-hidden="true">
  <path d="M10 0 V44" stroke="#d9d4e6" stroke-opacity=".7" stroke-width=".7"/>
  <path d="M7 46 l-5 -4 M7 49 l-6 0 M7 52 l-5 4 M13 46 l5 -4 M13 49 l6 0 M13 52 l5 4" stroke="#120c1c" stroke-width="1.3" stroke-linecap="round"/>
  <ellipse cx="10" cy="50" rx="4.6" ry="5.4" fill="#120c1c" stroke="#7a4bd6" stroke-width=".7"/>
  <circle cx="8.4" cy="48.5" r="1" fill="#ff4d4d"/><circle cx="11.6" cy="48.5" r="1" fill="#ff4d4d"/>
</svg>`,

  skull: `
<svg viewBox="0 0 30 34" aria-hidden="true">
  <path d="M3 17 Q3 2 15 2 Q27 2 27 17 Q27 22 23 24 L23 29 L7 29 L7 24 Q3 22 3 17 Z" fill="#ece6d6"/>
  <ellipse cx="10" cy="16" rx="4" ry="4.4" fill="#05060d"/><ellipse cx="20" cy="16" rx="4" ry="4.4" fill="#05060d"/>
  <circle cx="10" cy="16" r="1.3" fill="#ff8a1f"/><circle cx="20" cy="16" r="1.3" fill="#ff8a1f"/>
  <path d="M15 20 l-1.6 3 h3.2 Z" fill="#05060d"/>
  <path d="M9 29 v4 h12 v-4 M12 29 v4 M15 29 v4 M18 29 v4" stroke="#05060d" stroke-width=".8" fill="#ece6d6"/>
</svg>`,

  pumpkin: `
<svg viewBox="0 0 30 26" aria-hidden="true">
  <path d="M15 5 q1 -4 5 -5" stroke="#5a8a2e" stroke-width="2.2" fill="none" stroke-linecap="round"/>
  <ellipse cx="15" cy="15" rx="14" ry="10.5" fill="#e8680f"/>
  <ellipse cx="15" cy="15" rx="7.5" ry="10.5" fill="#ff8a1f"/>
  <path d="M6 10 L12 13 L6 14 Z M24 10 L18 13 L24 14 Z" fill="#2a0e00"/>
  <path d="M7 18 L10 20 L12 18 L15 21 L18 18 L20 20 L23 18 L21 23 L9 23 Z" fill="#2a0e00"/>
</svg>`,

  slime: `
<svg viewBox="0 0 30 24" aria-hidden="true">
  <path d="M2 24 Q0 8 15 4 Q30 8 28 24 Z" fill="#6fdc4a" stroke="#3f9a2a" stroke-width="1"/>
  <ellipse cx="11" cy="4.5" rx="2" ry="1" fill="#6fdc4a"/>
  <circle cx="11" cy="14" r="2.6" fill="#fff"/><circle cx="19" cy="14" r="2.6" fill="#fff"/>
  <circle cx="11.6" cy="14.4" r="1.2" fill="#05060d"/><circle cx="18.4" cy="14.4" r="1.2" fill="#05060d"/>
  <path d="M8 10 l5 2 M22 10 l-5 2" stroke="#1f4d14" stroke-width="1.2" stroke-linecap="round"/>
  <ellipse cx="9" cy="8" rx="2.5" ry="1.2" fill="#b9f5a3" opacity=".7"/>
</svg>`,

  puff: `
<svg viewBox="0 0 40 30" aria-hidden="true">
  <circle cx="12" cy="18" r="9" fill="#8f86a3"/><circle cx="24" cy="14" r="11" fill="#a59dba"/>
  <circle cx="31" cy="21" r="7" fill="#8f86a3"/><circle cx="18" cy="23" r="7" fill="#b7b0c9"/>
  <path d="M6 6 l3 3 M34 4 l-2 4 M20 1 v4" stroke="#ffd166" stroke-width="1.4" stroke-linecap="round"/>
</svg>`,

  bucket: `
<svg viewBox="0 0 20 20" aria-hidden="true">
  <path d="M4 7 Q10 -2 16 7" stroke="#3a2f22" stroke-width="1.4" fill="none"/>
  <ellipse cx="10" cy="13" rx="8" ry="6.5" fill="#ff8a1f"/>
  <path d="M6 11 l1.5 -2 l1.5 2 Z M11 11 l1.5 -2 l1.5 2 Z M6.5 15 q3.5 2.5 7 0" fill="#2a0e00" stroke="#2a0e00" stroke-width=".6"/>
</svg>`

};

/* a bad guy, placed in the stage, px from its left edge */
function peekActor(bot, name, { left = 110, width = 34, height = 34, bottom = 0, start = 'translateY(110%)' } = {}) {
  const el = document.createElement('div');
  el.className = 'peekBaddie';
  el.style.cssText = `left:${left}px;width:${width}px;height:${height}px;bottom:${bottom}px;transform:${start}`;
  el.innerHTML = PEEK_ACTORS[name];
  bot.stage.appendChild(el);
  el.go = (frames, ms, easing = 'ease-out') =>
    el.animate(frames, { duration: ms * bot.tempo, easing, fill: 'forwards' }).finished.catch(() => {});
  return el;
}

/* the robot's spot inside the stage, sideways, for the routines that move him */
const at = (y, x = 0, extra = '') => peekPose(y, `translateX(${x}px) ${extra}`.trim());

/*
  Every devil routine uses the whole width of the message
  box. W is the stage width in px; X(f) is where the robot
  stands at that fraction of the way along; L(f) is where a
  bad guy stands.
*/
const devilRoutines = [

  /* 1. the candy thief: a chase the full length of the box */
  async bot => {
    const { W } = bot;
    const X = f => Math.round((W - 70) * f);
    const L = f => Math.round(W * f);
    const start = X(0.02);
    const end = X(0.86);
    const thief = peekActor(bot, 'thief', { left: L(0.3) });
    await bot.move([at(PEEK_HIDDEN, start), at(PEEK_EYES, start)], 420, 'cubic-bezier(.2,.8,.3,1)');
    await bot.look(3.5);
    await thief.go([{ transform: 'translateY(110%)' }, { transform: 'translateY(6%)' }], 320, 'cubic-bezier(.3,1.4,.5,1)');
    bot.eyes('open');
    await thief.go([{ transform: 'translateY(6%) rotate(-10deg)' }, { transform: 'translateY(6%) rotate(10deg)' }, { transform: 'translateY(6%) rotate(0deg)' }], 380, 'ease-in-out');
    await bot.flare();
    const n = 16;
    const run = [];
    const flee = [];
    const thiefEnd = W - L(0.3) - 44;
    for (let i = 0; i <= n; i += 1) {
      run.push(at(i % 2 ? PEEK_EYES - 12 : PEEK_EYES, Math.round(start + (end - start) * i / n), `rotate(${i % 2 ? 9 : 6}deg)`));
      flee.push({ transform: `translateX(${Math.round(thiefEnd * i / n)}px) translateY(${i % 2 ? -8 : 6}%)` });
    }
    await Promise.all([bot.move(run, 3400, 'ease-in-out'), thief.go(flee, 3400, 'ease-in-out')]);
    await thief.go([{ transform: `translateX(${thiefEnd}px) translateY(6%)` }, { transform: `translateX(${thiefEnd + 90}px) translateY(0%)` }], 360, 'ease-in');
    bot.eyes('happy');
    await bot.look(3.5); await bot.wait(450); await bot.look(-3.5); await bot.wait(450); await bot.look(0);
    await bot.move([at(PEEK_EYES, end), at(PEEK_HIDDEN, end)], 300, 'ease-in');
    await bot.wait(400);
    bot.handAt(end);
    await bot.move([at(PEEK_HIDDEN, end), at(PEEK_HIGH, end)], 420, 'cubic-bezier(.3,1.4,.5,1)');
    bot.eyes('wink');
    await bot.wave(2);
    bot.eyes('happy');
    await bot.move([at(PEEK_HIGH, end), at(PEEK_HIDDEN, end)], 400, 'ease-in');
  },

  /* 2. a vampire bat swoops the whole length of the box at him */
  async bot => {
    const { W } = bot;
    const bx = Math.round((W - 70) * 0.45);
    const batLeft = W - 40;
    const over = bx + 10 - batLeft;
    const bat = peekActor(bot, 'bat', { left: batLeft, width: 34, height: 17, bottom: 62, start: 'translate(80px, -30px)' });
    bat.firstElementChild.animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(.5)' }], { duration: 160, iterations: Infinity, direction: 'alternate' });
    await bot.move([at(PEEK_HIDDEN, bx), at(PEEK_EYES, bx)], 420, 'cubic-bezier(.2,.8,.3,1)');
    await bot.look(3.5);
    await bat.go([{ transform: 'translate(80px, -30px)' }, { transform: `translate(${over + 60}px, -4px)` }, { transform: `translate(${over}px, -8px)` }], 1300, 'ease-out');
    bot.eyes('open');
    await bot.look(0);
    await bot.wait(300);
    await Promise.all([
      bat.go([{ transform: `translate(${over}px, -8px)` }, { transform: `translate(${over - 40}px, 44px)` }, { transform: `translate(${-batLeft - 60}px, 10px)` }], 1100, 'ease-in'),
      (async () => { await bot.wait(120); await bot.move([at(PEEK_EYES, bx), at(PEEK_HIDDEN, bx)], 160, 'ease-in'); })()
    ]);
    await bot.wait(400);
    await bat.go([{ transform: `translate(${-batLeft - 60}px, 10px)` }, { transform: `translate(${over - 30}px, 6px)` }, { transform: `translate(${over}px, 8px)` }], 1100, 'ease-out');
    await bot.move([at(PEEK_HIDDEN, bx), at(PEEK_HIGH, bx)], 260, 'cubic-bezier(.3,1.4,.5,1)');
    await bot.flare();
    await bat.go([{ transform: `translate(${over}px, 8px) rotate(0deg)` }, { transform: `translate(${over + 160}px, -120px) rotate(900deg)` }], 900, 'ease-in');
    bot.eyes('happy');
    await bot.blink();
    await bot.wait(300);
    await bot.move([at(PEEK_HIGH, bx), at(PEEK_HIDDEN, bx)], 400, 'ease-in');
  },

  /* 3. a ghost creeps up behind him; one roar and it flees the length of the box */
  async bot => {
    const { W } = bot;
    const bx = Math.round((W - 70) * 0.3);
    const ghostLeft = bx + 58;
    const ghost = peekActor(bot, 'ghost', { left: ghostLeft, width: 26, height: 32 });
    await bot.move([at(PEEK_HIDDEN, bx), at(PEEK_EYES, bx)], 480, 'cubic-bezier(.2,.8,.3,1)');
    await bot.look(-3.5);
    await Promise.all([
      ghost.go([{ transform: 'translateY(110%)', opacity: 0 }, { transform: 'translateY(8%)', opacity: .95 }], 1100, 'ease-out'),
      (async () => { await bot.wait(500); await bot.blink(); })()
    ]);
    await ghost.go([{ transform: 'translateY(8%) translateX(0px)', opacity: .95 }, { transform: 'translateY(8%) translateX(-9px)', opacity: .95 }], 500, 'ease-in-out');
    await bot.look(3.5);
    bot.eyes('open');
    await bot.move([at(PEEK_EYES, bx), at(PEEK_HIGH - 6, bx)], 150, 'ease-out');
    const away = W - ghostLeft + 40;
    await Promise.all([
      bot.flare(1.9),
      ghost.go([
        { transform: 'translateY(8%) translateX(-9px)', opacity: .95 },
        { transform: `translateY(-20%) translateX(${Math.round(away * .5)}px)`, opacity: .95 },
        { transform: `translateY(0%) translateX(${away}px)`, opacity: .8 }
      ], 1600, 'ease-in')
    ]);
    await bot.move([at(PEEK_HIGH - 6, bx), at(PEEK_EYES, bx)], 300, 'ease-out');
    bot.eyes('happy');
    await bot.look(0);
    await bot.blink();
    await bot.wait(300);
    await bot.move([at(PEEK_EYES, bx), at(PEEK_HIDDEN, bx)], 380, 'ease-in');
  },

  /* 4. whack a zombie: hands pop up all along the box, he flattens them */
  async bot => {
    const { W } = bot;
    const spots = [0.22, 0.62, 0.92].map(f => Math.round((W - 30) * f));
    const hand = peekActor(bot, 'zombie', { left: spots[0], width: 20, height: 32 });
    const up = [{ transform: 'translateY(110%)' }, { transform: 'translateY(4%)' }];
    const down = [{ transform: 'translateY(4%)' }, { transform: 'translateY(110%)' }];
    let x = 0;
    await bot.move([at(PEEK_HIDDEN, x), at(PEEK_EYES, x)], 420, 'cubic-bezier(.2,.8,.3,1)');
    for (const [i, spot] of spots.entries()) {
      hand.style.left = `${spot}px`;
      await hand.go(up, 260, 'cubic-bezier(.3,1.4,.5,1)');
      await bot.look(spot > x ? 3.5 : -3.5);
      bot.eyes('open');
      const target = spot - 18;
      const mid = Math.round((x + target) / 2);
      await bot.move([at(PEEK_EYES, x), at(PEEK_HIGH - 38, mid), at(PEEK_HIGH, target)], 520, 'ease-out');
      await Promise.all([bot.move([at(PEEK_HIGH, target), at(PEEK_HIDDEN, target)], 150, 'ease-in'), hand.go(down, 150, 'ease-in')]);
      x = target;
      if (i < spots.length - 1) {
        await bot.wait(200);
        await bot.move([at(PEEK_HIDDEN, x), at(PEEK_EYES, x)], 260, 'ease-out');
      }
    }
    await bot.wait(300);
    bot.eyes('wink');
    bot.handAt(x);
    await bot.move([at(PEEK_HIDDEN, x), at(PEEK_HIGH, x)], 320, 'cubic-bezier(.3,1.4,.5,1)');
    await bot.flare(1.6);
    await bot.wave(1);
    bot.eyes('happy');
    await bot.move([at(PEEK_HIGH, x), at(PEEK_HIDDEN, x)], 380, 'ease-in');
  },

  /* 5. a witch flies the whole length of the box; he jumps for her broom and misses */
  async bot => {
    const { W } = bot;
    const bx = Math.round((W - 70) * 0.55);
    const witch = peekActor(bot, 'witch', { left: W, width: 52, height: 31, bottom: 62, start: 'translateX(20px)' });
    await bot.move([at(PEEK_HIDDEN, bx), at(PEEK_EYES, bx)], 420, 'cubic-bezier(.2,.8,.3,1)');
    await bot.look(3.5);
    const trip = W + 90;
    const fly = witch.go([
      { transform: 'translate(20px, 0px)' },
      { transform: `translate(${-trip * .25}px, 8px)` },
      { transform: `translate(${-trip * .5}px, -4px)` },
      { transform: `translate(${-trip * .75}px, 6px)` },
      { transform: `translate(${-trip}px, -10px)` }
    ], 3400, 'linear');
    /* when she is overhead: she covers the box at an even pace */
    const overhead = ((W + 20 - (bx + 28)) / (trip + 20)) * 3400;
    await bot.wait(Math.max(0, overhead - 700));
    bot.eyes('open');
    await bot.look(0);
    await bot.wait(250);
    await bot.move([at(PEEK_EYES, bx), at(PEEK_HIGH - 26, bx, 'rotate(-8deg)'), at(PEEK_EYES, bx)], 520, 'ease-in-out');
    await bot.look(-3.5);
    await fly;
    bot.eyes('happy');
    await bot.move([at(PEEK_EYES, bx, 'rotate(0deg)'), at(PEEK_EYES, bx, 'rotate(10deg)'), at(PEEK_EYES, bx, 'rotate(-10deg)'), at(PEEK_EYES, bx, 'rotate(0deg)')], 700, 'ease-in-out');
    await bot.flare(1.5);
    await bot.look(0);
    await bot.move([at(PEEK_EYES, bx), at(PEEK_HIDDEN, bx)], 380, 'ease-in');
  },

  /* 6. spiders drop in front of him at both ends of the box; he blows each away */
  async bot => {
    const { W } = bot;
    const spots = [Math.round((W - 70) * 0.1), Math.round((W - 70) * 0.8)];
    const spider = peekActor(bot, 'spider', { left: spots[0] + 18, width: 20, height: 60, bottom: 34, start: 'translateY(-140%)' });
    for (const [i, bx] of spots.entries()) {
      if (i === 0) {
        await bot.move([at(PEEK_HIDDEN, bx), at(PEEK_EYES, bx)], 480, 'cubic-bezier(.2,.8,.3,1)');
      } else {
        spider.style.left = `${bx + 18}px`;
        const n = 12;
        const run = [];
        for (let k = 0; k <= n; k += 1) run.push(at(k % 2 ? PEEK_EYES - 10 : PEEK_EYES, Math.round(spots[0] + (bx - spots[0]) * k / n)));
        await bot.look(3.5);
        await bot.move(run, 1800, 'ease-in-out');
        await bot.look(0);
      }
      await bot.wait(250);
      await spider.go([{ transform: 'translateY(-140%)' }, { transform: 'translateY(-4%)' }, { transform: 'translateY(-10%)' }], 1000, 'ease-out');
      bot.eyes('open');
      await bot.look(-2); await bot.wait(250); await bot.look(2); await bot.wait(250); await bot.look(0);
      await Promise.all([bot.flare(2), (async () => { await bot.wait(200); await spider.go([{ transform: 'translateY(-10%)' }, { transform: 'translateY(-150%)' }], 260, 'ease-in'); })()]);
      bot.eyes('happy');
    }
    await bot.blink();
    const last = spots[1];
    await bot.move([at(PEEK_EYES, last, 'rotate(0deg)'), at(PEEK_EYES, last, 'rotate(8deg)'), at(PEEK_EYES, last, 'rotate(0deg)')], 400, 'ease-in-out');
    await bot.move([at(PEEK_EYES, last), at(PEEK_HIDDEN, last)], 380, 'ease-in');
  },

  /* 7. a stare down across the box with a skull, which falls to bits */
  async bot => {
    const { W } = bot;
    const skullLeft = Math.round(W * 0.8);
    const skull = peekActor(bot, 'skull', { left: skullLeft, width: 30, height: 34 });
    const start = Math.round((W - 70) * 0.05);
    const close = skullLeft - 58;
    await Promise.all([
      bot.move([at(PEEK_HIDDEN, start), at(PEEK_EYES, start)], 520, 'cubic-bezier(.2,.8,.3,1)'),
      skull.go([{ transform: 'translateY(110%)' }, { transform: 'translateY(10%)' }], 520, 'cubic-bezier(.2,.8,.3,1)')
    ]);
    await bot.look(3.5);
    bot.eyes('open');
    /* a slow, menacing walk up to it, one step at a time */
    const n = 10;
    const walk = [];
    for (let k = 0; k <= n; k += 1) walk.push(at(k % 2 ? PEEK_EYES - 5 : PEEK_EYES, Math.round(start + (close - start) * k / n), `rotate(${k % 2 ? 4 : -2}deg)`));
    await bot.move(walk, 2400, 'linear');
    await Promise.all([
      bot.move([at(PEEK_EYES, close, 'rotate(0deg)'), at(PEEK_EYES, close + 8, 'rotate(6deg)')], 500, 'ease-in-out'),
      skull.go([{ transform: 'translateY(10%) translateX(0px)' }, { transform: 'translateY(10%) translateX(-8px) rotate(-6deg)' }], 500, 'ease-in-out')
    ]);
    await bot.wait(900);
    await skull.go([
      { transform: 'translateY(10%) translateX(-8px) rotate(-6deg)' },
      { transform: 'translateY(10%) translateX(-6px) rotate(4deg)' },
      { transform: 'translateY(10%) translateX(-10px) rotate(-8deg)' },
      { transform: 'translateY(10%) translateX(-8px) rotate(-6deg)' }
    ], 300, 'linear');
    await bot.flare(1.8);
    await skull.go([
      { transform: 'translateY(10%) translateX(-8px) rotate(-6deg)' },
      { transform: 'translateY(-30%) translateX(6px) rotate(40deg)' },
      { transform: 'translateY(120%) translateX(24px) rotate(160deg)' }
    ], 650, 'ease-in');
    bot.eyes('happy');
    bot.handAt(close);
    await bot.move([at(PEEK_EYES, close + 8, 'rotate(6deg)'), at(PEEK_HIGH, close, 'rotate(0deg)')], 300, 'ease-out');
    await bot.wave(1);
    await bot.move([at(PEEK_HIGH, close), at(PEEK_HIDDEN, close)], 380, 'ease-in');
  },

  /* 8. an evil pumpkin rolls the whole length of the box; he hops over it */
  async bot => {
    const { W } = bot;
    const bx = Math.round((W - 70) * 0.45);
    const pumpkin = peekActor(bot, 'pumpkin', { left: W, width: 30, height: 26, start: 'translateX(10px)' });
    await bot.move([at(PEEK_HIDDEN, bx), at(PEEK_EYES, bx)], 420, 'cubic-bezier(.2,.8,.3,1)');
    await bot.look(3.5);
    const trip = W + 50;
    const ms = 2800;
    const spins = Math.round(trip / 30);
    const roll = pumpkin.go([{ transform: 'translateX(10px) rotate(0deg)' }, { transform: `translateX(${-trip}px) rotate(${-spins * 90}deg)` }], ms, 'linear');
    const reach = ((W + 10 - (bx + 40)) / (trip + 10)) * ms;
    await bot.wait(Math.max(0, reach - 700));
    bot.eyes('open');
    await bot.wait(420);
    await bot.move([at(PEEK_EYES, bx), at(PEEK_HIGH - 38, bx, 'rotate(-10deg)'), at(PEEK_EYES, bx, 'rotate(0deg)')], 560, 'ease-in-out');
    await bot.look(-3.5);
    await roll;
    await bot.wait(300);
    bot.eyes('happy');
    await bot.flare(1.6);
    await bot.look(0);
    await bot.blink();
    await bot.move([at(PEEK_EYES, bx), at(PEEK_HIDDEN, bx)], 380, 'ease-in');
  },

  /* 9. a bouncing duel with a slime across the box; he flips over and it goes splat */
  async bot => {
    const { W } = bot;
    const bx = Math.round((W - 70) * 0.15);
    const slimeLeft = Math.round(W * 0.75);
    const slime = peekActor(bot, 'slime', { left: slimeLeft, width: 30, height: 24 });
    const boing = (el, top, ms) => el.go([{ transform: 'translateY(110%)' }, { transform: `translateY(${top}%)` }, { transform: 'translateY(110%)' }], ms, 'ease-in-out');
    await bot.move([at(PEEK_HIDDEN, bx), at(PEEK_EYES, bx)], 420, 'cubic-bezier(.2,.8,.3,1)');
    await bot.look(3.5);
    await bot.move([at(PEEK_EYES, bx), at(PEEK_HIDDEN, bx)], 200, 'ease-in');
    await boing(slime, -40, 520);
    await bot.move([at(PEEK_HIDDEN, bx), at(PEEK_HIGH - 20, bx), at(PEEK_HIDDEN, bx)], 560, 'ease-in-out');
    await boing(slime, -90, 620);
    bot.eyes('open');
    const land = slimeLeft - 60;
    await bot.move([
      { transform: `translateY(${PEEK_HIDDEN}%) translateX(${bx}px) rotate(0deg)`, transformOrigin: '50% 50%' },
      { transform: `translateY(${PEEK_HIGH - 45}%) translateX(${Math.round((bx + land) / 2)}px) rotate(180deg)`, transformOrigin: '50% 50%' },
      { transform: `translateY(${PEEK_EYES}%) translateX(${land}px) rotate(360deg)`, transformOrigin: '50% 50%' }
    ], 1200, 'ease-in-out');
    await slime.go([{ transform: 'translateY(110%)' }, { transform: 'translateY(8%)' }], 240, 'ease-out');
    await bot.flare(1.6);
    await slime.go([{ transform: 'translateY(8%) scale(1, 1)', transformOrigin: '50% 100%' }, { transform: 'translateY(8%) scale(1.7, .25)', transformOrigin: '50% 100%' }, { transform: 'translateY(110%) scale(1.7, .25)', transformOrigin: '50% 100%' }], 520, 'ease-in');
    bot.eyes('happy');
    bot.handAt(land);
    await bot.move([at(PEEK_EYES, land), at(PEEK_HIGH, land)], 240, 'ease-out');
    await bot.wave(1);
    await bot.move([at(PEEK_HIGH, land), at(PEEK_HIDDEN, land)], 380, 'ease-in');
  },

  /* 10. the thief again, at the far end, and this time one huge leap gets him */
  async bot => {
    const { W } = bot;
    const start = Math.round((W - 70) * 0.03);
    const thiefLeft = Math.round(W * 0.82);
    const land = thiefLeft - 4;
    const thief = peekActor(bot, 'thief', { left: thiefLeft });
    await bot.move([at(PEEK_HIDDEN, start), at(PEEK_EYES, start)], 420, 'cubic-bezier(.2,.8,.3,1)');
    await thief.go([{ transform: 'translateY(110%)' }, { transform: 'translateY(6%)' }], 320, 'cubic-bezier(.3,1.4,.5,1)');
    await bot.look(3.5);
    bot.eyes('open');
    await bot.flare(1.5);
    await thief.go([{ transform: 'translateY(6%) translateX(0px)' }, { transform: 'translateY(6%) translateX(10px)' }], 200, 'ease-out');
    await bot.move([
      at(PEEK_EYES, start),
      at(PEEK_HIGH - 60, Math.round(start + (land - start) * .5), 'rotate(20deg)'),
      at(PEEK_HIGH, land, 'rotate(0deg)')
    ], 1100, 'ease-in-out');
    await Promise.all([
      bot.move([at(PEEK_HIGH, land), at(PEEK_HIDDEN, land)], 180, 'ease-in'),
      thief.go([{ transform: 'translateY(6%) translateX(10px)' }, { transform: 'translateY(110%) translateX(10px)' }], 180, 'ease-in')
    ]);
    const puff = peekActor(bot, 'puff', { left: land - 6, width: 44, height: 33, start: 'scale(.2)' });
    await puff.go([
      { transform: 'scale(.2) rotate(0deg)', opacity: 1 },
      { transform: 'scale(1) rotate(8deg)', opacity: 1 },
      { transform: 'scale(1) translateX(3px) rotate(-6deg)', opacity: 1 },
      { transform: 'scale(1) translateX(-3px) rotate(6deg)', opacity: 1 },
      { transform: 'scale(1.3) rotate(0deg)', opacity: 0 }
    ], 1300, 'ease-in-out');
    const bucket = peekActor(bot, 'bucket', { left: land + 50, width: 20, height: 20 });
    bot.handAt(land);
    await Promise.all([
      bot.move([at(PEEK_HIDDEN, land), at(PEEK_HIGH, land)], 420, 'cubic-bezier(.3,1.4,.5,1)'),
      bucket.go([{ transform: 'translateY(110%)' }, { transform: 'translateY(-30%)' }], 420, 'cubic-bezier(.3,1.4,.5,1)')
    ]);
    bot.eyes('wink');
    await bot.wave(2);
    bot.eyes('happy');
    await Promise.all([
      bot.move([at(PEEK_HIGH, land), at(PEEK_HIDDEN, land)], 400, 'ease-in'),
      bucket.go([{ transform: 'translateY(-30%)' }, { transform: 'translateY(110%)' }], 400, 'ease-in')
    ]);
  }

];

/* picks the next of the ten, all ten before any repeat */
let devilDeck = [];

async function peekDevil(bot) {
  if (!devilDeck.length) {
    devilDeck = devilRoutines.map((_, i) => i);
    for (let i = devilDeck.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [devilDeck[i], devilDeck[j]] = [devilDeck[j], devilDeck[i]];
    }
  }
  const pick = typeof bot.devilPick === 'number' ? bot.devilPick : devilDeck.shift();
  bot.devilPick = null;
  /* each measured at normal speed, stretched to last two seconds longer */
  /* each routine's length at normal speed, and what it should last:
     two seconds more than the version before this one */
  const lengths = [10238, 7980, 5794, 7713, 6129, 9728, 7945, 5228, 6978, 6695];
  const targets = [14020, 10700, 9180, 10910, 9090, 8910, 9760, 8500, 10710, 10240];
  bot.tempo = Math.max(1, targets[pick] / lengths[pick]);
  /* the whole width of the message box */
  bot.stage.style.left = '18px';
  bot.W = Math.max(240, (bot.card.clientWidth || 300) - 36);
  bot.stage.style.width = `${bot.W}px`;
  bot.stage.style.height = '170px';
  await devilRoutines[pick](bot);
}

const PEEK_MUMMY_HAND_SVG = `
<svg viewBox="0 0 18 30" aria-hidden="true">
  <rect x="6" y="11" width="6" height="19" rx="3" fill="#ddd3ba"/>
  <circle cx="9" cy="8.5" r="7" fill="#e8dfc8"/>
  <ellipse cx="3.2" cy="10.5" rx="2.4" ry="3.2" fill="#ddd3ba"/>
  <path d="M3 5 L15 8 M2.5 10 L15.5 12 M6 15 L12 16.5 M6 20 L12 21.5 M6 25 L12 26.5" stroke="#a89c7e" stroke-width=".8"/>
</svg>`;

/* how long the storm clouds take to roll in before the lightning */
const STORM_ROLL_IN = 1400;

const PEEK_COSTUMES = [

  /* 1. witch's hat */
  { hideAntenna: true, svg: `
    <path d="M17 13 Q25 -6 29 -22 Q32 -33 42 -28 Q35 -22 36 -10 L47 13 Z" fill="#231634" stroke="#6b3fc4" stroke-opacity=".6" stroke-width=".8"/>
    <rect x="18.5" y="6.5" width="27" height="5" rx="1" fill="#ff8a1f"/>
    <rect x="29" y="6" width="6" height="6" rx="1" fill="none" stroke="#ffd166" stroke-width="1.2"/>
    <ellipse cx="32" cy="14.5" rx="29" ry="4.5" fill="#1a1226" stroke="#6b3fc4" stroke-opacity=".6" stroke-width=".8"/>` },

  /* 2. vampire: slicked hair with a widow's peak, fangs and a cape collar round his chin */
  { hideAntenna: true, svg: `
    <path d="M8.5 27 Q8 12 32 11.5 Q56 12 55.5 27 Q52 20 46 18.5 L32 27 L18 18.5 Q12 20 8.5 27 Z" fill="#1a1024" stroke="#8a5cf0" stroke-opacity=".75" stroke-width="1"/>
    <path d="M20 14.5 Q30 12.5 44 14.5" stroke="#4a3a66" stroke-width="1" fill="none" stroke-linecap="round"/>
    <path d="M1 60 Q-2 50 4 44 Q10 52 18 56 L46 56 Q54 52 60 44 Q66 50 63 60 Z" fill="#b3122e"/>
    <path d="M6 58 Q5 52 7 48 Q12 54 18 57 L46 57 Q52 54 57 48 Q59 52 58 58 Z" fill="#5a0a1a"/>
    <path d="M26 43 l2 5.5 l2 -5.5 Z M34 43 l2 5.5 l2 -5.5 Z" fill="#fff"/>` },

  /* 3. a jack-o'-lantern keeps him company */
  { svg: `
    <path d="M81 22 q1 -5 5 -6" stroke="#5a8a2e" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <ellipse cx="81" cy="33" rx="13" ry="10" fill="#e8680f"/>
    <ellipse cx="81" cy="33" rx="7" ry="10" fill="#ff8a1f"/>
    <ellipse cx="81" cy="33" rx="2.6" ry="10" fill="#ff9d3d"/>
    <circle cx="81" cy="33" r="15" fill="#ff8a1f" opacity=".12" class="glow"/>
    <path d="M74 31 l2.5 -3 l2.5 3 Z M83 31 l2.5 -3 l2.5 3 Z" fill="#ffe07a"/>
    <path d="M74.5 36 q6.5 4.5 13 0 l-2 1 l-1 -1 l-2 1.4 l-2 -1.4 l-2 1.4 l-2 -1.4 l-1 1 Z" fill="#ffe07a"/>` },

  /* 4. all skeleton: a bone skull with glowing sockets, and a bony hand to wave */
  { skin: 'skeleton', hand: 'skeleton', under: `
    <path d="M12.5 27 Q13 20 20 21 Q24.5 21.5 29 25 Q31 30 30 37 Q29 43 24.5 43.5 Q18.5 44 15 40 Q12 35 12.5 27 Z" fill="#05060d"/>
    <path d="M51.5 27 Q51 20 44 21 Q39.5 21.5 35 25 Q33 30 34 37 Q35 43 39.5 43.5 Q45.5 44 49 40 Q52 35 51.5 27 Z" fill="#05060d"/>
    <path d="M32 40 l-2.6 5.5 q2.6 1.4 5.2 0 Z" fill="#05060d"/>
    <rect x="19" y="47" width="26" height="6.5" rx="1.5" fill="#05060d"/>
    <path d="M22.5 47.6 v5.4 M26 47.6 v5.4 M29.5 47.6 v5.4 M33 47.6 v5.4 M36.5 47.6 v5.4 M40 47.6 v5.4" stroke="#ece6d6" stroke-width="2.2"/>
    <path d="M26 15.5 l2.5 3.5 l-2 2.5 l3 3" stroke="#8d8573" stroke-width=".9" fill="none" stroke-linecap="round"/>
    <path d="M10.5 42 q2.5 3 6 3.5 M53.5 42 q-2.5 3 -6 3.5" stroke="#b9b09a" stroke-width=".9" fill="none"/>
    <rect x="18" y="60" width="28" height="24" rx="8" fill="#05060d"/>
    <path d="M32 60 V84" stroke="#ece6d6" stroke-width="2.4"/>
    <path d="M20 65 Q26 62 31 65 M44 65 Q38 62 33 65 M20 70.5 Q26 67.5 31 70.5 M44 70.5 Q38 67.5 33 70.5 M21 76 Q26 73 31 76 M43 76 Q38 73 33 76" stroke="#ece6d6" stroke-width="1.8" fill="none" stroke-linecap="round"/>
    <path d="M24 82 Q32 86 40 82" stroke="#ece6d6" stroke-width="2" fill="none"/>`, svg: `` },

  /* 5. a spider hangs from his antenna */
  { antenna: `
    <g class="bob">
      <path d="M44 7 Q58 4 64 14 L64 22" stroke="#d9d4e6" stroke-opacity=".7" stroke-width=".7" fill="none"/>
      <path d="M61 23 l-4 -3 M61 25 l-5 0 M61 27 l-4 3 M67 23 l4 -3 M67 25 l5 0 M67 27 l4 3" stroke="#120c1c" stroke-width="1.1" stroke-linecap="round"/>
      <ellipse cx="64" cy="25.5" rx="3.6" ry="4.2" fill="#120c1c" stroke="#7a4bd6" stroke-width=".6"/>
      <circle cx="62.8" cy="24" r=".7" fill="#ff4d4d"/>
      <circle cx="65.2" cy="24" r=".7" fill="#ff4d4d"/>
    </g>` },

  /* 6. black cat: ears and whiskers */
  { hideAntenna: true, svg: `
    <path d="M10 22 L13 1 L28 14 Z" fill="#1b1328" stroke="#3a2a55" stroke-width=".8"/>
    <path d="M54 22 L51 1 L36 14 Z" fill="#1b1328" stroke="#3a2a55" stroke-width=".8"/>
    <path d="M14 15 L15 7 L22 13.5 Z M50 15 L49 7 L42 13.5 Z" fill="#ff7ab8" opacity=".7"/>
    <path d="M30.5 42 h3 l-1.5 2 Z" fill="#ff7ab8"/>
    <path d="M12 40 L-2 37 M12 43.5 L-2 45 M52 40 L66 37 M52 43.5 L66 45" stroke="#e9e4f5" stroke-opacity=".8" stroke-width="1" stroke-linecap="round"/>` },

  /* 7. a little ghost pops up beside him, which is why he ducks */
  { svg: `
    <g class="rise">
      <path d="M70 48 L70 31 Q70 19 81 19 Q92 19 92 31 L92 48 l-3.7 -4 l-3.7 4 l-3.6 -4 l-3.6 4 l-3.7 -4 Z" fill="#f4f1ff"/>
      <ellipse cx="77" cy="30" rx="1.9" ry="2.6" fill="#1a1226"/>
      <ellipse cx="85" cy="30" rx="1.9" ry="2.6" fill="#1a1226"/>
      <ellipse cx="81" cy="37" rx="2.4" ry="3" fill="#1a1226"/>
    </g>` },

  /* 8. a spooky candle, flickering */
  { svg: `
    <circle cx="79" cy="24" r="11" fill="#ffb347" opacity=".18" class="glow"/>
    <rect x="74.5" y="28" width="9" height="20" rx="1.5" fill="#efe6d0"/>
    <path d="M74.5 30 q0 5 1.5 5 q1.5 0 1.5 -4 q0 7 1.8 7 q1.8 0 1.8 -6 q0 3 1.4 3 q1 0 1 -3 v-2 h-9 Z" fill="#fff8e8"/>
    <path d="M79 28 v-3" stroke="#3a2a1a" stroke-width="1"/>
    <image href="img/flame-single.webp" x="74.5" y="11" width="9" height="16" preserveAspectRatio="none"/>` },

  /* 9. huge devil horns on top of his head, and he chases a
     candy thief right along the top of the box */
  { hideAntenna: true, routine: peekDevil, svg: `
    <defs>
      <linearGradient id="hornL" gradientUnits="userSpaceOnUse" x1="19" y1="17" x2="-3" y2="-40">
        <stop offset="0" stop-color="#8e1410"/><stop offset=".22" stop-color="#d42a1e"/><stop offset=".5" stop-color="#b3160f"/><stop offset=".66" stop-color="#4a0b08"/><stop offset=".8" stop-color="#140505"/><stop offset="1" stop-color="#050101"/>
      </linearGradient>
      <linearGradient id="hornR" gradientUnits="userSpaceOnUse" x1="45" y1="17" x2="67" y2="-40">
        <stop offset="0" stop-color="#8e1410"/><stop offset=".22" stop-color="#d42a1e"/><stop offset=".5" stop-color="#b3160f"/><stop offset=".66" stop-color="#4a0b08"/><stop offset=".8" stop-color="#140505"/><stop offset="1" stop-color="#050101"/>
      </linearGradient>
    </defs>
    <radialGradient id="fireGlow"><stop offset="0" stop-color="#ff8a1f" stop-opacity=".45"/><stop offset=".6" stop-color="#ff6a13" stop-opacity=".14"/><stop offset="1" stop-color="#ff6a13" stop-opacity="0"/></radialGradient>
    <ellipse cx="32" cy="-12" rx="24" ry="20" fill="url(#fireGlow)"/>
    <image class="fire" href="img/flame-crown.webp" x="10" y="-29" width="44" height="33" preserveAspectRatio="none"/>
    <path d="M20.7 11.1 L19.0 10.8 L17.6 10.3 L16.1 9.6 L14.8 8.8 L13.4 7.8 L12.1 6.6 L10.9 5.2 L9.7 3.6 L8.5 1.8 L7.4 -0.1 L6.4 -2.3 L5.4 -4.6 L4.5 -7.1 L3.7 -9.7 L2.9 -12.4 L2.2 -15.2 L1.5 -18.1 L0.9 -21.1 L0.3 -24.1 L-0.3 -27.3 L-0.9 -30.4 L-1.4 -33.6 L-2.0 -36.8 L-2.7 -40.0 L-3.3 -40.0 L-3.5 -36.7 L-3.5 -33.4 L-3.6 -30.2 L-3.5 -26.9 L-3.5 -23.7 L-3.4 -20.6 L-3.2 -17.4 L-3.0 -14.4 L-2.7 -11.3 L-2.4 -8.4 L-1.9 -5.5 L-1.4 -2.6 L-0.8 0.1 L-0.1 2.8 L0.8 5.4 L1.8 7.9 L3.0 10.3 L4.4 12.6 L6.0 14.8 L7.8 16.9 L9.8 18.7 L12.1 20.4 L14.6 21.8 L17.3 22.9 Z" fill="url(#hornL)"/>
    <path d="M46.7 22.9 L49.4 21.8 L51.9 20.4 L54.2 18.7 L56.2 16.9 L58.0 14.8 L59.6 12.6 L61.0 10.3 L62.2 7.9 L63.2 5.4 L64.1 2.8 L64.8 0.1 L65.4 -2.6 L65.9 -5.5 L66.4 -8.4 L66.7 -11.3 L67.0 -14.4 L67.2 -17.4 L67.4 -20.6 L67.5 -23.7 L67.5 -26.9 L67.6 -30.2 L67.5 -33.4 L67.5 -36.7 L67.3 -40.0 L66.7 -40.0 L66.0 -36.8 L65.4 -33.6 L64.9 -30.4 L64.3 -27.3 L63.7 -24.1 L63.1 -21.1 L62.5 -18.1 L61.8 -15.2 L61.1 -12.4 L60.3 -9.7 L59.5 -7.1 L58.6 -4.6 L57.6 -2.3 L56.6 -0.1 L55.5 1.8 L54.3 3.6 L53.1 5.2 L51.9 6.6 L50.6 7.8 L49.2 8.8 L47.9 9.6 L46.4 10.3 L45.0 10.8 L43.3 11.1 Z" fill="url(#hornR)"/>
    <path d="M16.1 13.1 L14.4 12.1 L12.8 11.0 L11.4 9.8 L10.0 8.3 L8.7 6.6 L7.5 4.8 L6.4 2.8 L5.4 0.7 L4.4 -1.6 L3.5 -4.1 L2.7 -6.6 L2.0 -9.3 L1.4 -12.1" stroke="#ffd0c4" stroke-opacity=".45" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    <path d="M47.9 13.1 L49.6 12.1 L51.2 11.0 L52.6 9.8 L54.0 8.3 L55.3 6.6 L56.5 4.8 L57.6 2.8 L58.6 0.7 L59.6 -1.6 L60.5 -4.1 L61.3 -6.6 L62.0 -9.3 L62.6 -12.1" stroke="#ffd0c4" stroke-opacity=".45" stroke-width="1.3" stroke-linecap="round" fill="none"/>` },

  /* 10. skull face paint */
  { svg: `
    <circle cx="24.5" cy="35" r="7.5" fill="none" stroke="#f4f1ff" stroke-opacity=".75" stroke-width="1.4"/>
    <circle cx="39.5" cy="35" r="7.5" fill="none" stroke="#f4f1ff" stroke-opacity=".75" stroke-width="1.4"/>
    <path d="M32 41 l-1.8 3 h3.6 Z" fill="#f4f1ff" fill-opacity=".8"/>
    <path d="M22 47 h20 M25 45.5 v3 M28.3 45.5 v3 M31.6 45.5 v3 M34.9 45.5 v3 M38.2 45.5 v3" stroke="#f4f1ff" stroke-opacity=".75" stroke-width="1" stroke-linecap="round"/>` },

  /* 11. all mummy: wrapped head to toe, just a slit for his eyes */
  { skin: 'mummy', hand: 'mummy', antenna: `
    <path d="M37.6 13.5 l3.4 -1.4 M38.2 10.5 l3.2 -1.4 M38.8 7.8 l3 -1.2" stroke="#b3a88c" stroke-width="1.1" stroke-linecap="round"/>`, svg: `
    <g stroke-linecap="round" fill="none">
      <path d="M8 16.5 L56 20" stroke="#e8dfc8" stroke-width="5"/>
      <path d="M7 22 L57 25.5" stroke="#ddd3ba" stroke-width="5"/>
      <path d="M7.5 28 L27 27" stroke="#e8dfc8" stroke-width="4.2"/>
      <path d="M38 27.2 L56.5 28.6" stroke="#e8dfc8" stroke-width="4.2"/>
      <path d="M7 43.5 L57 41.5" stroke="#e8dfc8" stroke-width="5"/>
      <path d="M7 48.5 L57 47.5" stroke="#ddd3ba" stroke-width="5"/>
      <path d="M9 53.5 L55 54.5" stroke="#e8dfc8" stroke-width="4.5"/>
      <path d="M2.5 30 L10.5 27 M2.5 36 L10.5 33.5 M2.5 42 L10.5 39.5 M53.5 27 L61.5 30 M53.5 33.5 L61.5 36 M53.5 39.5 L61.5 42" stroke="#ddd3ba" stroke-width="3"/>
      <path d="M57 47.5 q8 3 8.5 12" stroke="#e8dfc8" stroke-width="3.6"/>
      <path d="M8 19 L56 22.7 M7.2 46 L56.8 44.5 M8 51 L56 51.3" stroke="#a89c7e" stroke-width=".7"/>
      <path d="M20 17.5 l1.8 1.8 M35 19 l1.8 1.8 M24 42.5 l1.6 1.6 M44 47.5 l1.6 1.6" stroke="#b3a88c" stroke-width=".8"/>
      <path d="M16 62 L48 60 M15.5 68 L48.5 66.5 M15.5 74 L48.5 73 M16 80 L48 79.5" stroke="#e8dfc8" stroke-width="3.6"/>
      <path d="M20 88 L29 86 M20 93 L29 91.5 M35 86 L44 88 M35 91.5 L44 93" stroke="#ddd3ba" stroke-width="2.6"/>
      <path d="M44 81 q6 2 5 10" stroke="#e8dfc8" stroke-width="2.6"/>
    </g>` },

  /* 12. a Frankenstein flat top, neck bolts and stitches */
  { hideAntenna: true, svg: `
    <path d="M9 17 L9 9 Q9 6 12 6 L52 6 Q55 6 55 9 L55 17 L51 14 L47 18 L43 14 L39 18 L35 14 L31 18 L27 14 L23 18 L19 14 L15 18 L12 15 Z" fill="#1b1328"/>
    <rect x="-2" y="31" width="5.5" height="7" rx="1" fill="#9aa3b5"/>
    <rect x="60.5" y="31" width="5.5" height="7" rx="1" fill="#9aa3b5"/>
    <path d="M22 51.5 h14 M24 50 v3 M27.5 50 v3 M31 50 v3 M34.5 50 v3" stroke="#1b1328" stroke-width="1.2" stroke-linecap="round"/>` },

  /* 13. carries a lantern in the lift */
  { svg: `
    <circle cx="79" cy="32" r="15" fill="#ffb347" opacity=".2" class="glow"/>
    <path d="M73 21 Q79 12 85 21" stroke="#6d5a3f" stroke-width="1.6" fill="none"/>
    <rect x="71" y="21" width="16" height="4" rx="1" fill="#3a2f22"/>
    <rect x="72.5" y="25" width="13" height="15" fill="#ffb347" opacity=".9"/>
    <path d="M79 25 v15 M72.5 32.5 h13" stroke="#3a2f22" stroke-width="1.2"/>
    <rect x="71" y="40" width="16" height="3" rx="1" fill="#3a2f22"/>` },

  /* 14. flies on a broomstick */
  { svg: `
    <path d="M6 57 L100 47" stroke="#8a5a2b" stroke-width="3" stroke-linecap="round"/>
    <path d="M9 53 L-4 50 L-4 64 L9 61 Z" fill="#d9a441"/>
    <path d="M-3 53 L8 55 M-3 57 L8 57 M-3 61 L8 59" stroke="#a87424" stroke-width=".8"/>
    <rect x="7" y="53" width="3.5" height="8.5" rx="1" fill="#6b3fc4"/>` },

  /* 15. a ghost sheet with eye holes */
  { hideAntenna: true, svg: `
    <path d="M1 106 L1 26 Q1 -4 32 -4 Q63 -4 63 26 L63 106 l-5.2 -6 l-5.2 6 l-5.2 -6 l-5.2 6 l-5.2 -6 l-5.2 6 l-5.2 -6 l-5.2 6 l-5.2 -6 l-5.2 6 l-5.2 -6 Z" fill="#f4f1ff" opacity=".96"/>
    <path d="M10 10 Q18 2 26 1" stroke="#ffffff" stroke-width="2" stroke-linecap="round" fill="none" opacity=".8"/>
    <ellipse cx="24.5" cy="33" rx="4" ry="5.2" fill="#05060d"/>
    <ellipse cx="39.5" cy="33" rx="4" ry="5.2" fill="#05060d"/>` },

  /* 16. bat wings for the periscope */
  { svg: `
    <path class="flapL" d="M8 30 Q-1 17 -5 25 Q-3 29 -5 33 Q-1 31 1 37 Q4 33 8 40 Z" fill="#1b1328" stroke="#7a4bd6" stroke-opacity=".7" stroke-width=".7"/>
    <path class="flapR" d="M56 30 Q65 17 69 25 Q67 29 69 33 Q65 31 63 37 Q60 33 56 40 Z" fill="#1b1328" stroke="#7a4bd6" stroke-opacity=".7" stroke-width=".7"/>` }

];

function halloweenOn() {
  return document.body.classList.contains('theme-halloween');
}


function createPeekBot(card) {

  if (!card || card.querySelector('.peekStage')) return null;

  const stage = document.createElement('div');
  stage.className = 'peekStage';

  const bot = document.createElement('div');
  bot.className = 'peekBot';
  bot.innerHTML = PEEK_SVG;

  const hand = document.createElement('div');
  hand.className = 'peekHand';
  hand.innerHTML = PEEK_HAND_SVG;

  stage.appendChild(bot);
  stage.appendChild(hand);
  card.appendChild(stage);

  const eyes = bot.querySelector('.eyes');
  const antenna = bot.querySelector('.antenna');
  const ball = antenna.querySelector('circle');

  const api = {

    stage,
    card,
    el: bot,
    devilPick: null,
    rounds: 0,

    busy: false,
    last: -1,
    deck: [],

    /* 1 is normal speed; the devil's routines run a little slower, so each lasts two seconds more */
    tempo: 1,

    wait: ms => new Promise(resolve => setTimeout(resolve, ms * api.tempo)),

    /* where he is now: below 0 his body is up above the edge */
    y: PEEK_HIDDEN,

    move(frames, duration, easing) {
      const last = /translateY\((-?[\d.]+)%\)/.exec(frames[frames.length - 1]?.transform || '');
      if (last) api.y = Number(last[1]);
      return bot.animate(frames, { duration: duration * api.tempo, easing, fill: 'forwards' }).finished.catch(() => {});
    },

    place(where) {
      const width = card.clientWidth || 300;
      const spots = {
        left: 18,
        middle: Math.round(width * 0.42),
        right: Math.max(18, width - 98)
      };
      stage.style.left = `${spots[where] ?? spots.left}px`;
    },

    eyes(kind) {
      bot.classList.toggle('eyesOpen', kind === 'open');
      bot.classList.toggle('winkRight', kind === 'wink');
    },

    async blink() {
      await eyes.animate(
        [{ transform: 'scaleY(1)' }, { transform: 'scaleY(.1)' }, { transform: 'scaleY(1)' }],
        { duration: (180) * api.tempo, easing: 'ease-in-out' }
      ).finished.catch(() => {});
    },

    async look(x) {
      eyes.style.transform = `translateX(${x}px)`;
      await api.wait(180);
    },

    /* walks the whole stage sideways along the edge */
    travel(fromX, toX, duration, easing = 'linear') {
      const limit = Math.max(0, (card.clientWidth || 300) - 100 - (parseFloat(stage.style.left) || 0));
      const clamp = value => Math.max(-(parseFloat(stage.style.left) || 0), Math.min(limit, value));
      return stage.animate(
        [{ transform: `translateX(${clamp(fromX)}px)` }, { transform: `translateX(${clamp(toX)}px)` }],
        { duration: duration * api.tempo, easing, fill: 'forwards' }
      ).finished.catch(() => {});
    },

    /* the antenna lights up, like a lift arriving */
    async ding() {
      await ball.animate(
        [{ fill: '#8fdcff' }, { fill: '#fff6b0' }, { fill: '#ffe066' }, { fill: '#8fdcff' }],
        { duration: (520) * api.tempo, easing: 'ease-in-out' }
      ).finished.catch(() => {});
    },

    /* a little mitten pops up beside him and waves */
    async wave(times = 2) {
      /* standing up, he waves his own arm; peeking, the little mitten pops up */
      if (api.y < 0) {
        const arm = bot.querySelector('.armR');
        const swing = [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-150deg)' }];
        for (let i = 0; i < times; i += 1) swing.push({ transform: 'rotate(-120deg)' }, { transform: 'rotate(-160deg)' });
        swing.push({ transform: 'rotate(-150deg)' }, { transform: 'rotate(0deg)' });
        await arm.animate(swing, { duration: (300 + 360 * times) * api.tempo, easing: 'ease-in-out' }).finished.catch(() => {});
        return;
      }
      await hand.animate(
        [{ transform: 'translateY(110%)' }, { transform: 'translateY(8%)' }],
        { duration: (260) * api.tempo, easing: 'cubic-bezier(.3,1.3,.5,1)', fill: 'forwards' }
      ).finished.catch(() => {});
      const swing = [];
      for (let i = 0; i < times; i += 1) {
        swing.push(
          { transform: 'translateY(8%) rotate(0deg)' },
          { transform: 'translateY(8%) rotate(24deg)' },
          { transform: 'translateY(8%) rotate(-14deg)' }
        );
      }
      swing.push({ transform: 'translateY(8%) rotate(0deg)' });
      await hand.animate(swing, { duration: (360 * times) * api.tempo, easing: 'ease-in-out', fill: 'forwards' }).finished.catch(() => {});
      await hand.animate(
        [{ transform: 'translateY(8%)' }, { transform: 'translateY(110%)' }],
        { duration: (220) * api.tempo, easing: 'ease-in', fill: 'forwards' }
      ).finished.catch(() => {});
    },

    async wiggle() {
      await antenna.animate(
        [
          { transform: 'rotate(0deg)' },
          { transform: 'rotate(-16deg)' },
          { transform: 'rotate(14deg)' },
          { transform: 'rotate(-8deg)' },
          { transform: 'rotate(0deg)' }
        ],
        { duration: (650) * api.tempo, easing: 'ease-in-out' }
      ).finished.catch(() => {});
    },

    /* puts on this routine's Halloween costume, if the theme is on */
    dress(pick) {
      api.undress();
      if (!halloweenOn()) return;
      const costume = PEEK_COSTUMES[pick];
      if (!costume) return;
      if (costume.svg) {
        bot.insertAdjacentHTML('beforeend',
          `<svg class="peekCostume" viewBox="-8 -40 112 104" aria-hidden="true">${costume.svg}</svg>`);
      }
      if (costume.antenna) {
        antenna.insertAdjacentHTML('beforeend', `<g class="costumeBit">${costume.antenna}</g>`);
      }
      if (costume.hideAntenna) bot.classList.add('noAntenna');
      if (costume.hand === 'skeleton') hand.innerHTML = PEEK_SKELETON_HAND_SVG;
      if (costume.hand === 'mummy') hand.innerHTML = PEEK_MUMMY_HAND_SVG;
      if (costume.skin) bot.classList.add(`skin-${costume.skin}`);
      if (costume.under) {
        eyes.insertAdjacentHTML('beforebegin', `<g class="costumeBit">${costume.under}</g>`);
      }
    },

    /* the fire between the horns roars up, then settles */
    async flare(size = 1.6) {
      const fire = bot.querySelector('.peekCostume .fire');
      if (!fire) return;
      await fire.animate(
        [{ transform: 'scale(1)' }, { transform: `scale(${size})` }, { transform: `scale(${size * .92})` }, { transform: 'scale(1)' }],
        { duration: (650) * api.tempo, easing: 'ease-out' }
      ).finished.catch(() => {});
    },

    /* moves the waving hand along with him, when a routine has moved him */
    handAt(x) {
      hand.style.left = `${54 + x}px`;
    },

    undress() {
      bot.querySelectorAll('.peekCostume, .costumeBit').forEach(node => node.remove());
      stage.querySelectorAll('.peekBaddie').forEach(node => node.remove());
      stage.style.width = '';
      stage.style.height = '';
      api.tempo = 1;
      hand.style.left = '';
      bot.classList.remove('skin-skeleton', 'skin-mummy');
      bot.classList.remove('noAntenna');
      if (!hand.querySelector('rect[fill="#2f6fe8"]')) hand.innerHTML = PEEK_HAND_SVG;
    },

    async play(index) {

      if (api.busy) return;

      api.busy = true;

      let pick = index;

      /*
        A shuffled deck: all ten play once, in a random
        order, before any repeats. A fresh deck never starts
        with the one that just played.
      */
      if (typeof pick !== 'number') {

        if (!api.deck.length) {

          api.deck = peekRoutines.map((_, i) => i);

          for (let i = api.deck.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [api.deck[i], api.deck[j]] = [api.deck[j], api.deck[i]];
          }

          /*
            Halloween: the devil comes round half as often
            again as the others, twice in every other deck,
            never twice in a row.
          */
          api.rounds += 1;
          const devil = PEEK_COSTUMES.findIndex(costume => costume?.routine);
          if (halloweenOn() && devil >= 0 && api.rounds % 2 === 0) {
            const first = api.deck.indexOf(devil);
            let spot = Math.floor(Math.random() * (api.deck.length + 1));
            while (Math.abs(spot - first) < 2 || Math.abs(spot - first - 1) < 1) {
              spot = (spot + 3) % (api.deck.length + 1);
            }
            api.deck.splice(spot, 0, devil);
          }

          if (api.deck[0] === api.last && api.deck.length > 1) {
            api.deck.push(api.deck.shift());
          }

        }

        pick = api.deck.shift();

      }

      api.last = pick;

      /* start from a clean, hidden spot on the left */
      api.eyes('happy');
      eyes.style.transform = '';
      api.y = PEEK_HIDDEN;
      api.place('left');

      /* the devil is coming: thunder and lightning, then five seconds */
      if (halloweenOn() && PEEK_COSTUMES[pick]?.routine) {
        strikeStorm();
        await api.wait(STORM_ROLL_IN + 5000);
      }

      api.dress(pick);

      try {
        const special = halloweenOn() && PEEK_COSTUMES[pick]?.routine;
        await (special || peekRoutines[pick])(api);
      } finally {
        bot.getAnimations().forEach(animation => animation.cancel());
        hand.getAnimations().forEach(animation => animation.cancel());
        stage.getAnimations().forEach(animation => animation.cancel());
        ball.getAnimations().forEach(animation => animation.cancel());
        api.eyes('happy');
        eyes.style.transform = '';
        api.undress();
        api.busy = false;
      }

    }

  };

  return api;

}


/* now and then, never in the way; how often is set in the admin panel */
let restartPeeking = null;

(function startPeeking() {

  const card = document.querySelector('.composer');

  if (!card || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  const peekBot = createPeekBot(card);

  if (!peekBot) return;

  let timer = null;

  const gap = () => {
    const seconds = Number(account?.peekSeconds ?? 30);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    /* somewhere between the set time and ten seconds after it */
    return (seconds + Math.random() * 10) * 1000;
  };

  const shouldSkip = () =>
    document.hidden ||
    !card.offsetParent ||
    (messageInput.value || '').trim().length > 0 ||
    document.querySelector('.voiceScreen.show, .profileOverlay.show, .adminOverlay.show, .payOverlay.show');

  const schedule = delay => {

    clearTimeout(timer);

    /* switched off: look again in a while in case that changes */
    if (delay === null) {
      timer = setTimeout(() => schedule(gap()), 30000);
      return;
    }

    timer = setTimeout(async () => {

      if (gap() !== null && !shouldSkip()) {
        try { await peekBot.play(); } catch {}
      }

      schedule(gap());

    }, delay);

  };

  /* lets an admin (or a test) call up any routine by number */
  window.natterPeek = peekBot;

  restartPeeking = () => {
    const next = gap();
    schedule(next === null ? null : Math.min(next, 5000));
  };

  schedule(5000 + Math.random() * 3000);

  /*
    Halloween: the devil's first visit is about 30 seconds
    after the page opens. The lightning warning plays five
    seconds before, so it starts at 25. If he cannot show
    then (typing, another routine playing, another screen
    open), he tries again a few seconds later.
  */
  const devil = PEEK_COSTUMES.findIndex(costume => costume?.routine);

  const firstDevil = () => {
    if (!halloweenOn() || devil < 0) return;
    if (peekBot.busy || shouldSkip()) {
      setTimeout(firstDevil, 3000);
      return;
    }
    peekBot.play(devil).catch(() => {});
  };

  setTimeout(firstDevil, 25000 - STORM_ROLL_IN);

})();


/* =====================================================
   NEW VIDEO AND VOICE: WHO GETS THEM

   Set in the admin panel, for every account at once: off
   (nobody, admins included), admins only, or everyone.
   The server decides; this only shows what it said.
===================================================== */

function paintTestFeatures() {

  if (account?.theme && typeof applySiteTheme === 'function') applySiteTheme(account.theme);
  if (typeof paintThemeSwitch === 'function') paintThemeSwitch();

  const showVideo = account?.canVideo === true;
  const showVoice = account?.canVoice === true;

  document.getElementById('videoButton')?.classList.toggle('show', showVideo);
  document.getElementById('voiceButton')?.classList.toggle('show', showVoice);

  if (!showVideo && typeof videoMode !== 'undefined' && videoMode) {
    setVideoMode(false);
  }

  document.querySelectorAll('.accessSwitch').forEach(group => {

    const current = account?.[`${group.dataset.feature}Access`] || 'admins';

    group.querySelectorAll('button').forEach(button => {
      const on = button.dataset.access === current;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

  });

  const note = document.getElementById('adminFeaturesNote');

  if (note) {

    const word = value => ({ off: 'off', admins: 'admins', everyone: 'everyone' })[value] || 'admins';

    const peek = Number(account?.peekSeconds ?? 30);

    note.textContent =
      `Video ${word(account?.videoAccess)}, voice ${word(account?.voiceAccess)}, ` +
      (peek > 0 ? `robot every ${peek} to ${peek + 10}s` : 'robot off');

  }

}

document.querySelectorAll('.accessSwitch').forEach(group => {

  group.addEventListener('click', async event => {

    const button = event.target.closest('button[data-access]');

    if (!button || button.classList.contains('on')) return;

    const feature = group.dataset.feature;

    const previous = account[`${feature}Access`];

    /* show it straight away, put it back if the save fails */
    account[`${feature}Access`] = button.dataset.access;
    paintTestFeatures();

    try {

      const response =
        await fetch(`${API_BASE}/api/admin/settings`, {
          method: 'POST',
          headers: await apiHeaders(),
          body: JSON.stringify({ [`${feature}_access`]: button.dataset.access })
        });

      const data = await response.json();

      if (!response.ok) throw new Error(data?.error || 'Could not save.');

      await refreshAccount();

      const label = { off: 'off for everyone, admins included', admins: 'on for admins only', everyone: 'on for everyone' }[button.dataset.access];

      adminSay(
        'adminFeaturesResult',
        data.volatile
          ? `${feature === 'video' ? 'New Video' : 'Voice chat'} is ${label}, but only until the server restarts. Run the feature SQL in Supabase to make it stick.`
          : `${feature === 'video' ? 'New Video' : 'Voice chat'} is now ${label}.`,
        !data.volatile
      );

    } catch (error) {

      account[`${feature}Access`] = previous;
      paintTestFeatures();
      adminSay('adminFeaturesResult', error.message, false);

    }

  });

});

paintTestFeatures();


/* =====================================================
   SITE THEME

   Set in the admin page for everyone. The server says
   which theme is showing (Automatic is worked out there),
   and the last one is remembered on this device so the
   sign in and sign up screens wear it straight away.
===================================================== */

const THEME_KEY = 'natter_theme';

const THEME_WEB_SVG = `
<svg viewBox="0 0 100 100" fill="none" stroke="#e9e4f5" stroke-width=".9" aria-hidden="true">
  <path d="M0 0 L100 38 M0 0 L78 78 M0 0 L38 100 M0 0 L100 8 M0 0 L8 100"/>
  <path d="M22 1.8 Q17 9 20.2 20.2 Q9 17 1.8 22"/>
  <path d="M44 3.5 Q35 18 40 40 Q18 35 3.5 44"/>
  <path d="M66 5.3 Q52 27 58 58 Q27 52 5.3 66"/>
  <path d="M88 7 Q70 36 76 76 Q36 70 7 88"/>
  <path d="M40 40 L41 64" stroke-opacity=".7"/>
  <circle cx="41" cy="66.5" r="2.4" fill="#e9e4f5" stroke="none"/>
</svg>`;

const THEME_BAT_SVG = `
<svg viewBox="0 0 40 20" aria-hidden="true">
  <path d="M20 8 Q14 1 6 3 Q8 6 2 8 Q7 9 6 13 Q12 10 16 14 Q18 10 20 12 Q22 10 24 14 Q28 10 34 13 Q33 9 38 8 Q32 6 34 3 Q26 1 20 8 Z" fill="#0b0712" stroke="#7a4bd6" stroke-opacity=".6" stroke-width=".6"/>
</svg>`;

/* a jagged bolt with a branch or two, drawn fresh each strike */
function lightningSvg() {
  const walk = (x, y, endY, spread) => {
    const points = [[x, y]];
    while (y < endY) {
      y = Math.min(endY, y + 30 + Math.random() * 60);
      x = Math.max(32, Math.min(68, x + (Math.random() - .5) * spread));
      points.push([x, y]);
    }
    return points;
  };
  const main = walk(50, 0, 1000, 15);
  const branches = [];
  for (let i = 0; i < 2; i += 1) {
    const from = main[2 + Math.floor(Math.random() * Math.max(1, main.length - 6))];
    if (from) branches.push(walk(from[0], from[1], from[1] + 150 + Math.random() * 200, 18));
  }
  const d = points => 'M' + points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(0)}`).join(' L');
  const line = (points, width, colour, extra = '') =>
    `<path d="${d(points)}" stroke="${colour}" stroke-width="${width}" fill="none" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"${extra}/>`;
  return `<svg viewBox="0 0 100 1000" preserveAspectRatio="none" aria-hidden="true">` +
    branches.map(b => line(b, 1.6, '#e6dcff', ' opacity=".8"')).join('') +
    line(main, 4, '#cbb8ff', ' opacity=".6"') +
    line(main, 2, '#ffffff') +
    '</svg>';
}

/*
  The storm is the devil's warning: the clouds shake with
  thunder and lightning strikes five seconds before he
  turns up, and at no other time.
*/
function strikeStorm() {
  const decor = document.getElementById('themeDecor');
  if (!halloweenOn() || !decor ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const bolt = decor.querySelector('.bolt');
  if (bolt) {
    /* a fresh fork every time, from the very top down to 60 to 90 percent of the screen */
    bolt.style.left = `${10 + Math.random() * 75}%`;
    bolt.style.height = `${60 + Math.random() * 30}vh`;
    bolt.innerHTML = lightningSvg();
  }
  /* the clouds roll in, then thunder and lightning, then they roll away */
  decor.classList.remove('storm');
  decor.classList.add('clouding');
  clearTimeout(strikeStorm.timers?.[0]);
  clearTimeout(strikeStorm.timers?.[1]);
  clearTimeout(strikeStorm.timers?.[2]);
  strikeStorm.timers = [
    setTimeout(() => { void decor.offsetWidth; decor.classList.add('storm'); }, STORM_ROLL_IN),
    setTimeout(() => decor.classList.remove('storm'), STORM_ROLL_IN + 1600),
    setTimeout(() => decor.classList.remove('clouding'), STORM_ROLL_IN + 3200)
  ];
}

function fillThemeDecor() {

  const decor = document.getElementById('themeDecor');

  if (!decor || decor.childElementCount) return;

  /* the moving flames, fetched early so they are ready when he needs them */
  ['img/flame-crown.webp', 'img/flame-single.webp'].forEach(src => { const img = new Image(); img.src = src; });

  decor.innerHTML =
    '<div class="flash"></div>' +
    '<div class="clouds"></div>' +
    '<div class="bolt"></div>' +
    `<div class="web left">${THEME_WEB_SVG}</div>` +
    `<div class="web right">${THEME_WEB_SVG}</div>` +
    `<div class="bat">${THEME_BAT_SVG}</div>` +
    `<div class="bat two">${THEME_BAT_SVG}</div>`;

}

function applySiteTheme(theme) {

  if (theme !== 'halloween' && theme !== 'standard') return;

  const halloween = theme === 'halloween';

  if (halloween) fillThemeDecor();

  document.body.classList.toggle('theme-halloween', halloween);

  try { localStorage.setItem(THEME_KEY, theme); } catch {}

}

function paintThemeSwitch() {

  const current = account?.siteTheme || 'standard';

  document.querySelectorAll('.themeSwitch button').forEach(button => {
    const on = button.dataset.theme === current;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  });

  const note = document.getElementById('adminThemeNote');

  if (note) {
    const showing = account?.theme === 'halloween' ? 'Halloween showing' : 'standard showing';
    note.textContent =
      current === 'auto'
        ? `Automatic, ${showing}`
        : current === 'halloween' ? 'Halloween' : 'Standard';
  }

}

document.querySelector('.themeSwitch')?.addEventListener('click', async event => {

  const button = event.target.closest('button[data-theme]');

  if (!button || button.classList.contains('on')) return;

  const previous = { siteTheme: account.siteTheme, theme: account.theme };

  account.siteTheme = button.dataset.theme;
  if (button.dataset.theme !== 'auto') account.theme = button.dataset.theme;
  paintThemeSwitch();
  applySiteTheme(account.theme);

  try {

    const response =
      await fetch(`${API_BASE}/api/admin/settings`, {
        method: 'POST',
        headers: await apiHeaders(),
        body: JSON.stringify({ site_theme: button.dataset.theme })
      });

    const data = await response.json();

    if (!response.ok) throw new Error(data?.error || 'Could not save.');

    await refreshAccount();

    const label = { standard: 'Standard', halloween: 'Halloween', auto: 'Automatic' }[button.dataset.theme];

    adminSay(
      'adminThemeResult',
      data.volatile
        ? `${label} is on, but only until the server restarts. Run the theme SQL in Supabase to make it stick.`
        : `${label} is now on for everyone.`,
      !data.volatile
    );

  } catch (error) {

    Object.assign(account, previous);
    paintThemeSwitch();
    applySiteTheme(account.theme || 'standard');
    adminSay('adminThemeResult', error.message, false);

  }

});

if (halloweenOn()) fillThemeDecor();

/* before sign in: ask the server which theme is showing */
fetch(`${API_BASE}/api/account`)
  .then(response => response.ok ? response.json() : null)
  .then(data => {
    if (data?.theme && !account?.signedIn) applySiteTheme(data.theme);
  })
  .catch(() => {});



/* =====================================================
   SAVED COMMENTS

   The bookmark on a reply keeps it in the "Saved comments"
   list under your chats, on every device. Saved text is
   sealed with your key like everything else. Until the
   saved_comments table exists in Supabase, they are kept
   on this device and moved across once it does.
===================================================== */

let savedComments = [];
let savedOnDeviceOnly = false;

const SAVED_LOCAL = () => `nastivee_saved_${currentUser?.id || 'guest'}`;

function savedKey(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
}

function isSavedComment(text) {
  const key = savedKey(text);
  return Boolean(key) && savedComments.some(item => savedKey(item.content) === key);
}

function readLocalSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_LOCAL()) || '[]'); } catch { return []; }
}

function writeLocalSaved(list) {
  try { localStorage.setItem(SAVED_LOCAL(), JSON.stringify(list)); } catch {}
}

async function loadSavedComments() {

  if (guestMode || !currentUser) {
    savedOnDeviceOnly = true;
    savedComments = readLocalSaved();
    paintSaved();
    return;
  }

  const { data, error } =
    await supabaseClient
      .from('saved_comments')
      .select('id, chat_id, content, created_at')
      .order('created_at', { ascending: false })
      .limit(200);

  if (error) {
    /* no table yet: keep them on this device for now */
    console.warn('SAVED COMMENTS ON THIS DEVICE ONLY:', error.message);
    savedOnDeviceOnly = true;
    savedComments = readLocalSaved();
    paintSaved();
    return;
  }

  savedOnDeviceOnly = false;

  savedComments = (await decRows(data, ['content'])).filter(item => !item.__locked);

  /* anything saved on this device before the table existed moves across */
  const local = readLocalSaved();

  if (local.length) {

    for (const item of local.reverse()) {
      if (isSavedComment(item.content)) continue;
      const { data: row } =
        await supabaseClient
          .from('saved_comments')
          .insert({ user_id: currentUser.id, chat_id: item.chat_id || null, content: await encField(item.content) })
          .select('id, created_at')
          .single();
      if (row) savedComments.unshift({ ...item, id: row.id, created_at: row.created_at });
    }

    writeLocalSaved([]);

  }

  paintSaved();

}

async function toggleSavedComment(text, chatId) {

  const content = String(text || '').trim();

  if (!content) return;

  const key = savedKey(content);
  const existing = savedComments.find(item => savedKey(item.content) === key);

  if (existing) {
    await removeSavedComment(existing);
    return;
  }

  const item = {
    id: `local-${Date.now()}`,
    chat_id: chatId ? String(chatId) : null,
    content,
    created_at: new Date().toISOString()
  };

  if (!savedOnDeviceOnly && currentUser && !guestMode) {

    const { data: row, error } =
      await supabaseClient
        .from('saved_comments')
        .insert({ user_id: currentUser.id, chat_id: item.chat_id, content: await encField(content) })
        .select('id, created_at')
        .single();

    if (error) {
      console.error('SAVE COMMENT ERROR:', error);
      savedOnDeviceOnly = true;
    } else {
      item.id = row.id;
      item.created_at = row.created_at;
    }

  }

  savedComments.unshift(item);

  if (savedOnDeviceOnly) {
    writeLocalSaved(savedComments);
  }

  paintSaved();

  /* show them it landed */
  savedSection.classList.add('open');
  savedSummary.setAttribute('aria-expanded', 'true');

}

async function removeSavedComment(item) {

  savedComments = savedComments.filter(other => other !== item);

  if (!savedOnDeviceOnly && !String(item.id).startsWith('local-')) {
    await supabaseClient.from('saved_comments').delete().eq('id', item.id);
  }

  if (savedOnDeviceOnly) {
    writeLocalSaved(savedComments);
  }

  paintSaved();

}

const savedSection = document.getElementById('savedSection');
const savedSummary = document.getElementById('savedSummary');
const savedList = document.getElementById('savedList');
const savedViewer = document.getElementById('savedViewer');

function plainPreview(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/[#*_`>]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function paintSaved() {

  document.getElementById('savedCount').textContent = String(savedComments.length);

  savedList.innerHTML = '';

  if (!savedComments.length) {
    const empty = document.createElement('div');
    empty.className = 'savedEmpty';
    empty.textContent = 'Tap the bookmark under any reply to keep it here.';
    savedList.appendChild(empty);
  }

  savedComments.forEach(item => {

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'savedItem';

    const text = document.createElement('span');
    text.textContent = plainPreview(item.content).slice(0, 160);

    button.appendChild(text);
    button.addEventListener('click', () => openSavedViewer(item));

    savedList.appendChild(button);

  });

  document.getElementById('savedHint').textContent =
    savedOnDeviceOnly && currentUser && !guestMode
      ? 'Kept on this device for now.'
      : '';

  /* bookmarks on screen follow along */
  document.querySelectorAll('.messageBubble').forEach(bubble => bubble.paintKeep?.());

}

let viewing = null;

function openSavedViewer(item) {

  viewing = item;

  const chatTitle = chats.find(chatRow => String(chatRow.id) === String(item.chat_id))?.title;

  document.getElementById('savedViewerMeta').textContent =
    [
      chatTitle ? `From "${chatTitle}"` : 'Saved comment',
      new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    ].join(' · ');

  document.getElementById('savedViewerBody').innerHTML = renderMarkdown(item.content);

  document.getElementById('savedViewerOpen').style.display = chatTitle ? '' : 'none';

  savedViewer.classList.add('show');

}

function closeSavedViewer() {
  savedViewer.classList.remove('show');
  viewing = null;
}

savedSummary.addEventListener('click', () => {
  const open = !savedSection.classList.contains('open');
  savedSection.classList.toggle('open', open);
  savedSummary.setAttribute('aria-expanded', open ? 'true' : 'false');
});

document.getElementById('savedViewerClose').addEventListener('click', closeSavedViewer);

savedViewer.addEventListener('click', event => {
  if (event.target === savedViewer) closeSavedViewer();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && savedViewer.classList.contains('show')) closeSavedViewer();
});

document.getElementById('savedViewerCopy').addEventListener('click', event => {
  if (!viewing) return;
  navigator.clipboard?.writeText(viewing.content).then(() => {
    event.target.textContent = 'Copied';
    setTimeout(() => { event.target.textContent = 'Copy'; }, 1200);
  }).catch(() => {});
});

document.getElementById('savedViewerOpen').addEventListener('click', async () => {
  if (!viewing?.chat_id) return;
  const id = viewing.chat_id;
  closeSavedViewer();
  closeMobileSidebar?.();
  await loadChat(id);
});

document.getElementById('savedViewerRemove').addEventListener('click', async () => {
  if (!viewing) return;
  const item = viewing;
  closeSavedViewer();
  await removeSavedComment(item);
});

paintSaved();


/* =====================================================
   ADMIN: RULES

   Word swaps the server applies before anything reaches
   the AI. Edited here as a list, saved in one go.
===================================================== */

const STARTER_RULE = {
  words: ['sexy', 'sexier', 'sexiest'],
  replace: 'visually striking and magnetic with an alluring, sophisticated aesthetic',
  target: 'all',
  enabled: true
};

let rulesDraft = [];
let rulesLoaded = false;

const rulesList = document.getElementById('rulesList');

function paintRulesNote() {
  const on = rulesDraft.filter(rule => rule.enabled !== false).length;
  const note = document.getElementById('adminRulesNote');
  if (note) note.textContent = rulesDraft.length ? `${on} of ${rulesDraft.length} on` : 'None yet';
}

function paintRules() {

  rulesList.innerHTML = '';

  rulesDraft.forEach((rule, index) => {

    const card = document.createElement('div');
    card.className = `ruleCard${rule.enabled === false ? ' off' : ''}`;

    card.innerHTML = `
      <div class="ruleTop">
        <span class="ruleTitle">Rule ${index + 1}</span>
        <button type="button" class="adminSwitch ${rule.enabled === false ? '' : 'on'}" data-role="toggle">${rule.enabled === false ? 'Off' : 'On'}</button>
        <button type="button" class="ruleRemove" data-role="remove" title="Remove this rule" aria-label="Remove this rule">${icon('trash', 16)}</button>
      </div>
      <label>When someone types any of these (separate with commas)</label>
      <input class="adminInput" data-role="words" type="text" autocomplete="off" spellcheck="false">
      <label>Swap it for</label>
      <textarea class="adminInput" data-role="replace" rows="2"></textarea>
      <label>Applies to</label>
      <div class="accessSwitch" data-role="target">
        <button type="button" data-target="images">Images and video</button>
        <button type="button" data-target="chat">Chat</button>
        <button type="button" data-target="all">Both</button>
      </div>`;

    card.querySelector('[data-role="words"]').value = (rule.words || []).join(', ');
    card.querySelector('[data-role="replace"]').value = rule.replace || '';

    card.querySelectorAll('[data-target]').forEach(button => {
      button.classList.toggle('on', button.dataset.target === (rule.target || 'all'));
    });

    card.querySelector('[data-role="words"]').addEventListener('input', event => {
      rule.words = event.target.value.split(',').map(word => word.trim()).filter(Boolean);
    });

    card.querySelector('[data-role="replace"]').addEventListener('input', event => {
      rule.replace = event.target.value;
    });

    card.querySelector('[data-role="target"]').addEventListener('click', event => {
      const button = event.target.closest('[data-target]');
      if (!button) return;
      rule.target = button.dataset.target;
      paintRules();
    });

    card.querySelector('[data-role="toggle"]').addEventListener('click', () => {
      rule.enabled = rule.enabled === false;
      paintRules();
    });

    card.querySelector('[data-role="remove"]').addEventListener('click', () => {
      rulesDraft.splice(index, 1);
      paintRules();
    });

    rulesList.appendChild(card);

  });

  paintRulesNote();

}

function loadRulesFromAdmin(settings) {

  if (rulesLoaded) return;

  rulesLoaded = true;

  const saved = Array.isArray(settings?.rules) ? settings.rules : [];

  rulesDraft = saved.length
    ? saved.map(rule => ({ ...rule, words: [...(rule.words || [])] }))
    : [{ ...STARTER_RULE, words: [...STARTER_RULE.words] }];

  paintRules();

  if (!saved.length) {
    adminSay('rulesResult', 'Here is your example rule, ready to go. It is not live until you press Save rules.', true);
  }

}

document.getElementById('addRule')?.addEventListener('click', () => {
  rulesDraft.push({ words: [], replace: '', target: 'all', enabled: true });
  paintRules();
  rulesList.querySelector('.ruleCard:last-child [data-role="words"]')?.focus();
});

document.getElementById('saveRules')?.addEventListener('click', async () => {

  const button = document.getElementById('saveRules');

  const cleaned = rulesDraft.filter(rule => (rule.words || []).length);

  button.disabled = true;

  try {

    const response =
      await fetch(`${API_BASE}/api/admin/settings`, {
        method: 'POST',
        headers: await apiHeaders(),
        body: JSON.stringify({ rules: cleaned })
      });

    const data = await response.json();

    if (!response.ok) throw new Error(data?.error || 'Could not save.');

    rulesDraft = cleaned;

    paintRules();

    adminSay(
      'rulesResult',
      data.volatile
        ? 'Rules are live, but only until the server restarts. Run the rules SQL in Supabase to make them stick.'
        : `Saved. ${cleaned.filter(rule => rule.enabled !== false).length} rule(s) are live for everyone.`,
      !data.volatile
    );

  } catch (error) {

    adminSay('rulesResult', error.message, false);

  } finally {

    button.disabled = false;

  }

});

/* =====================================================
   ADMIN PAGE: THE MENU

   Builds the drawer from the sections themselves, so a new
   section appears in the menu without extra work, with
   its state colour and summary line kept up to date.
===================================================== */

const ADMIN_PAGE_KEY = 'nastivee_admin_page';

function adminSections() {
  return [...adminCard.querySelectorAll(':scope > .adminSection')];
}

function sectionName(section) {
  const text = section.querySelector('.adminSummaryText');
  return (text?.childNodes[0]?.textContent || section.id).trim();
}

function paintAdminMenu() {

  const list = document.getElementById('adminDrawerList');

  if (!list) return;

  list.innerHTML = '';

  adminSections().forEach(section => {

    const item = document.createElement('button');
    item.type = 'button';

    const state =
      ['bad', 'warn', 'good'].find(name => section.classList.contains(name)) || '';

    item.className = `adminNavItem ${state}${section.classList.contains('current') ? ' current' : ''}`;
    item.dataset.target = section.id;

    const note = section.querySelector('.adminSummaryNote')?.textContent?.trim() || '';

    item.innerHTML =
      '<span class="adminNavDot" aria-hidden="true"></span>' +
      '<span class="adminNavText"><span class="adminNavName"></span><span class="adminNavNote"></span></span>';

    item.querySelector('.adminNavName').textContent = sectionName(section);
    item.querySelector('.adminNavNote').textContent = note;

    item.addEventListener('click', () => {
      showAdminPage(section.id);
      setAdminDrawer(false);
    });

    list.appendChild(item);

  });

}

function showAdminPage(id) {

  const sections = adminSections();

  const target =
    sections.find(section => section.id === id) || sections[0];

  if (!target) return;

  sections.forEach(section => {
    const on = section === target;
    section.classList.toggle('current', on);
    section.classList.toggle('open', on);
  });

  document.getElementById('adminPageName').textContent = sectionName(target);

  try { localStorage.setItem(ADMIN_PAGE_KEY, target.id); } catch {}

  if (target.id === 'adminActivity' && typeof statData !== 'undefined' && statData) {
    requestAnimationFrame(paintStats);
  }

  if (target.id === 'adminUploads') {
    loadAdminUploads(true);
  }

  if (target.id === 'adminRefusals') {
    loadRefusals();
  }

  adminCard.scrollTop = 0;

  paintAdminMenu();

}

function setAdminDrawer(open) {
  adminOverlay.classList.toggle('drawerOpen', open);
  document.getElementById('adminBurger')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) paintAdminMenu();
}

document.getElementById('adminBurger')?.addEventListener('click', () => {
  setAdminDrawer(!adminOverlay.classList.contains('drawerOpen'));
});

document.getElementById('adminDrawerShade')?.addEventListener('click', () => setAdminDrawer(false));

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && adminOverlay.classList.contains('drawerOpen')) setAdminDrawer(false);
});

/* the menu's colours and notes follow the sections as they change */
if (window.MutationObserver) {
  new MutationObserver(() => {
    if (adminOverlay.classList.contains('show')) paintAdminMenu();
  }).observe(adminCard, { subtree: true, attributes: true, attributeFilter: ['class'], characterData: true, childList: true });
}

/* =====================================================
   HOUSE LESSONS

   A retry or a save may prompt the server to suggest one
   general lesson. Admins approve, edit or reject them in
   the admin page; approved ones shape every reply.
===================================================== */

function suggestLesson(kind, question, answer) {

  if (!currentUser || guestMode || !String(answer || '').trim()) return;

  apiHeaders()
    .then(headers =>
      fetch(`${API_BASE}/api/lessons/suggest`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          kind,
          question: String(question || '').slice(0, 1500),
          answer: String(answer || '').slice(0, 2500)
        })
      })
    )
    .catch(() => {});

}

let lessonsData = { auto: true, items: [] };

function paintLessons() {

  const items = Array.isArray(lessonsData.items) ? lessonsData.items : [];
  const pending = items.filter(item => item.status === 'pending');
  const live = items.filter(item => item.status === 'approved');

  const autoSwitch = document.getElementById('lessonsAuto');
  if (autoSwitch) {
    autoSwitch.classList.toggle('on', lessonsData.auto !== false);
    autoSwitch.textContent = lessonsData.auto !== false ? 'On' : 'Off';
  }

  const note = document.getElementById('adminLessonsNote');
  if (note) {
    note.textContent =
      pending.length
        ? `${pending.length} waiting for you, ${live.length} live`
        : `${live.length} live`;
  }

  const section = document.getElementById('adminLessons');
  section?.classList.toggle('warn', pending.length > 0);

  const build = (list, holder, isPending) => {

    holder.innerHTML = '';

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'lessonEmpty';
      empty.textContent = isPending ? 'Nothing waiting.' : 'No lessons live yet.';
      holder.appendChild(empty);
      return;
    }

    list.forEach(item => {

      const card = document.createElement('div');
      card.className = `lessonCard${isPending ? ' pending' : ''}`;

      const from = { retry: 'From a reply someone asked for again', saved: 'From a reply someone saved', admin: 'Added by an admin' }[item.from] || '';
      const when = item.created_at ? new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';

      card.innerHTML = `
        <div class="lessonMeta"></div>
        <textarea class="adminInput lessonText" rows="2"></textarea>
        <div class="lessonButtons"></div>`;

      card.querySelector('.lessonMeta').textContent = [from, when].filter(Boolean).join(' · ');

      const text = card.querySelector('textarea');
      text.value = item.text;

      const buttons = card.querySelector('.lessonButtons');

      const add = (label, action, cls = '') => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        if (cls) button.className = cls;
        button.addEventListener('click', () => lessonAction(action, item.id, text.value, button));
        buttons.appendChild(button);
      };

      if (isPending) {
        add('Approve', 'approve', 'primary');
        add('Reject', 'reject', 'danger');
      } else {
        add('Save changes', 'edit');
        add('Remove', 'remove', 'danger');
      }

      holder.appendChild(card);

    });

  };

  build(pending, document.getElementById('lessonsPending'), true);
  build(live, document.getElementById('lessonsLive'), false);

}

async function lessonAction(action, id, text, button) {

  if (button) button.disabled = true;

  try {

    const response =
      await fetch(`${API_BASE}/api/admin/lessons`, {
        method: 'POST',
        headers: await apiHeaders(),
        body: JSON.stringify({ action, id, text, auto: action === 'auto' ? text : undefined })
      });

    const data = await response.json();

    if (!response.ok) throw new Error(data?.error || 'Could not save.');

    lessonsData = data.lessons || lessonsData;

    if (adminData?.settings) adminData.settings.lessons = lessonsData;

    paintLessons();

    const said = {
      approve: 'Approved. It now shapes every reply.',
      reject: 'Rejected and removed.',
      remove: 'Removed.',
      edit: 'Saved.',
      add: 'Added and live for everyone.',
      auto: lessonsData.auto ? 'Suggestions are on.' : 'Suggestions are off.'
    }[action];

    adminSay(
      'lessonsResult',
      data.volatile
        ? `${said} It will not survive a server restart until the lessons SQL is run in Supabase.`
        : said,
      !data.volatile
    );

    return true;

  } catch (error) {

    adminSay('lessonsResult', error.message, false);

    return false;

  } finally {

    if (button) button.disabled = false;

  }

}

document.getElementById('lessonsAuto')?.addEventListener('click', event => {
  lessonAction('auto', null, lessonsData.auto === false, event.currentTarget);
});

document.getElementById('lessonAdd')?.addEventListener('click', async event => {
  const box = document.getElementById('lessonNew');
  if (!box.value.trim()) {
    adminSay('lessonsResult', 'Write the lesson first.', false);
    return;
  }
  if (await lessonAction('add', null, box.value, event.currentTarget)) {
    box.value = '';
  }
});

/* =====================================================
   MY ARTWORK

   Every picture and clip Natter has made for you, from
   all your chats, newest first. Thumbnails load as they
   scroll into view, sixty at a time.
===================================================== */

const artworkPage = document.getElementById('artworkPage');
const artworkGrid = document.getElementById('artworkGrid');
const artworkViewer = document.getElementById('artworkViewer');

const ARTWORK_PAGE_SIZE = 60;

let artworkItems = [];
let artworkOffset = 0;
let artworkDone = false;
let artworkViewing = null;

const artworkWatcher =
  window.IntersectionObserver
    ? new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          artworkWatcher.unobserve(entry.target);
          fillArtworkTile(entry.target);
        });
      }, { root: artworkPage, rootMargin: '300px' })
    : null;

async function fetchArtwork() {

  if (artworkView === 'uploads') {

    if (guestMode || !currentUser) return [];

    const { data, error } =
      await supabaseClient
        .from('uploads')
        .select('id, path, kind, created_at')
        .eq('user_id', currentUser.id)
        .order('created_at', { ascending: false })
        .range(artworkOffset, artworkOffset + ARTWORK_PAGE_SIZE - 1);

    if (error) throw error;

    return (data || []).map(row => ({
      id: row.id,
      chat_id: null,
      content: ({ ask: 'You asked about this photo', edit: 'You uploaded this to edit', video: 'Opening shot of a video' })[row.kind] || 'Uploaded photo',
      image_url: supabaseClient.storage.from(IMAGE_BUCKET).getPublicUrl(row.path).data.publicUrl,
      created_at: row.created_at
    }));

  }

  if (guestMode) {

    if (artworkOffset > 0) return [];

    const rows = [];

    guestChats().forEach(chatRow => {
      guestMessages(chatRow.id)
        .filter(item => item.role === 'assistant' && item.image_url)
        .forEach(item => rows.push({ ...item, chat_id: chatRow.id }));
    });

    return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  }

  const { data, error } =
    await supabaseClient
      .from('messages')
      .select('id, chat_id, content, image_url, created_at')
      .eq('user_id', currentUser.id)
      .eq('role', 'assistant')
      .not('image_url', 'is', null)
      .order('created_at', { ascending: false })
      .range(artworkOffset, artworkOffset + ARTWORK_PAGE_SIZE - 1);

  if (error) throw error;

  return decRows(data || [], ['content']);

}

async function loadMoreArtwork() {

  const more = document.getElementById('artworkMore');

  more.disabled = true;
  more.textContent = 'Loading...';

  try {

    const rows = await fetchArtwork();

    artworkOffset += rows.length;

    if (guestMode || rows.length < ARTWORK_PAGE_SIZE) artworkDone = true;

    rows.forEach(row => {
      artworkItems.push(row);
      artworkGrid.appendChild(makeArtworkTile(row));
    });

    paintArtworkHeader();

  } catch (error) {

    console.error('ARTWORK LOAD ERROR:', error);
    document.getElementById('artworkSub').textContent = 'Could not load your artwork. Try again in a moment.';

  } finally {

    more.disabled = false;
    more.textContent = 'Show more';
    more.style.display = artworkDone ? 'none' : '';

  }

}

function paintArtworkHeader() {

  const count = artworkItems.length;

  document.getElementById('artworkSub').textContent =
    count
      ? `${count}${artworkDone ? '' : '+'} piece${count === 1 ? '' : 's'}, newest first`
      : 'Nothing yet';

  if (!count && artworkDone && !artworkGrid.querySelector('.artworkEmpty')) {
    const empty = document.createElement('div');
    empty.className = 'artworkEmpty';
    empty.textContent =
      artworkView === 'uploads'
        ? (guestMode ? 'Create an account to keep your uploads here.' : 'Nothing uploaded yet. Photos you add with Edit Photo will gather here.')
        : 'Nothing here yet. Tap New Image in any chat and what you make will gather here.';
    artworkGrid.appendChild(empty);
  }

}

function makeArtworkTile(row) {

  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'artworkTile';
  tile.title = plainPreview(row.content || '').slice(0, 120) || 'Artwork';
  tile.artwork = row;

  if (isVideoRef(row.image_url)) {
    const badge = document.createElement('span');
    badge.className = 'artworkBadge';
    badge.textContent = 'Video';
    tile.appendChild(badge);
  }

  tile.addEventListener('click', () => openArtwork(row));

  if (artworkWatcher) artworkWatcher.observe(tile);
  else fillArtworkTile(tile);

  return tile;

}

async function fillArtworkTile(tile) {

  const row = tile.artwork;

  try {

    const url = await resolveImage(row.image_url);

    const media = document.createElement(isVideoRef(row.image_url) ? 'video' : 'img');

    if (media.tagName === 'VIDEO') {
      media.muted = true;
      media.playsInline = true;
      media.preload = 'metadata';
    } else {
      media.alt = tile.title;
      media.loading = 'lazy';
    }

    media.addEventListener(media.tagName === 'VIDEO' ? 'loadeddata' : 'load', () => tile.classList.add('ready'));

    media.src = url;

    tile.prepend(media);

  } catch (error) {

    console.warn('ARTWORK TILE ERROR:', error?.message);

    tile.classList.add('locked');

    const note = document.createElement('span');
    note.className = 'artworkLocked';
    note.textContent = 'Locked on this device';
    tile.prepend(note);

  }

}

async function openArtwork(row) {

  artworkViewing = row;

  const holder = document.getElementById('artworkViewerMedia');
  holder.innerHTML = '';

  const url = await resolveImage(row.image_url).catch(() => null);

  if (!url) {
    holder.innerHTML = '<div class="artworkLockedBig">This one was sealed with a key this device does not have. Open it on the device you made it on, or sign in again with your password here.</div>';
  }

  const media = document.createElement(isVideoRef(row.image_url) ? 'video' : 'img');

  if (media.tagName === 'VIDEO') {
    media.controls = true;
    media.playsInline = true;
  } else {
    media.alt = plainPreview(row.content || 'Artwork');
  }

  if (url) {
    media.src = url;
    holder.appendChild(media);
  }

  document.getElementById('artworkViewerPrompt').textContent = plainPreview(row.content || '');

  const chatTitle = (guestMode ? guestChats() : chats).find(chatRow => String(chatRow.id) === String(row.chat_id))?.title;

  document.getElementById('artworkViewerMeta').textContent =
    [
      row.created_at ? new Date(row.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '',
      chatTitle ? `in "${chatTitle}"` : ''
    ].filter(Boolean).join(' ');

  document.getElementById('artworkOpenChat').style.display = row.chat_id ? '' : 'none';

  artworkViewer.classList.add('show');

}

function closeArtworkViewer() {
  artworkViewer.classList.remove('show');
  document.getElementById('artworkViewerMedia').innerHTML = '';
  artworkViewing = null;
}

function openArtworkPage() {

  if (!currentUser && !guestMode) return;

  artworkItems = [];
  artworkOffset = 0;
  artworkDone = false;
  artworkGrid.innerHTML = '';
  document.getElementById('artworkSub').textContent = 'Loading...';

  artworkPage.classList.add('show');
  artworkPage.scrollTop = 0;

  closeMobileSidebar?.();

  loadMoreArtwork();

}

function closeArtworkPage() {
  closeArtworkViewer();
  artworkPage.classList.remove('show');
}

document.getElementById('artworkButton')?.addEventListener('click', openArtworkPage);
document.getElementById('artworkClose')?.addEventListener('click', closeArtworkPage);
document.getElementById('artworkMore')?.addEventListener('click', loadMoreArtwork);
document.getElementById('artworkViewerClose')?.addEventListener('click', closeArtworkViewer);

artworkViewer?.addEventListener('click', event => {
  if (event.target === artworkViewer) closeArtworkViewer();
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !artworkPage.classList.contains('show')) return;
  if (artworkViewer.classList.contains('show')) closeArtworkViewer();
  else closeArtworkPage();
});

document.getElementById('artworkDownload')?.addEventListener('click', async () => {

  if (!artworkViewing) return;

  try {

    const url = await resolveImage(artworkViewing.image_url);
    const video = isVideoRef(artworkViewing.image_url);
    const type = (String(url).match(/^data:([^;]+)/) || [])[1] || '';
    const ext = video ? 'mp4' : ({ 'image/jpeg': 'jpg', 'image/webp': 'webp' }[type] || 'png');

    const link = document.createElement('a');
    link.href = url;
    link.download = `natter-${Date.now()}.${ext}`;
    document.body.appendChild(link);
    link.click();
    link.remove();

  } catch (error) {
    console.error('ARTWORK DOWNLOAD ERROR:', error);
  }

});

document.getElementById('artworkOpenChat')?.addEventListener('click', async () => {
  if (!artworkViewing?.chat_id) return;
  const id = artworkViewing.chat_id;
  closeArtworkPage();
  await loadChat(id);
});

/* =====================================================
   UPLOADS

   Every photo someone uploads is kept: signed in users
   save the file to their own folder with a record of it;
   guests hand theirs to the server. People see their own
   under My artwork; admins can browse everyone's.
===================================================== */

async function recordUpload(dataUrl, kind, storedRef = null) {

  try {

    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return;

    if (guestMode || !currentUser) {
      fetch(`${API_BASE}/api/uploads/guest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, kind })
      }).catch(() => {});
      return;
    }

    const ref = storedRef || (await storeImage(dataUrl));
    const path = storagePathFromUrl(ref);

    if (!path) return;

    await supabaseClient.from('uploads').insert({ user_id: currentUser.id, path, kind });

  } catch (error) {

    console.warn('UPLOAD RECORD FAILED:', error?.message);

  }

}

/* My artwork: made for me, or my uploads */
let artworkView = 'made';

document.getElementById('artworkSwitch')?.addEventListener('click', event => {

  const button = event.target.closest('[data-view]');

  if (!button || button.dataset.view === artworkView) return;

  artworkView = button.dataset.view;

  document.querySelectorAll('#artworkSwitch [data-view]').forEach(one => {
    one.classList.toggle('active', one === button);
  });

  openArtworkPage();

});

/* the admin library */
let adminUploadOffset = 0;
let adminUploadViewing = null;

/* =====================================================
   BLOCKED REQUESTS

   Everything Natter turned down, with the line it crossed
   and what the person could have asked instead.
===================================================== */

function refusalWhen(value) {
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return '';
  const mins = Math.round((Date.now() - when.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} hours ago`;
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

async function loadRefusals() {

  const list = document.getElementById('refusalList');
  const note = document.getElementById('adminRefusalsNote');
  const section = document.getElementById('adminRefusals');

  if (!list) return;

  try {

    const response =
      await fetch(`${API_BASE}/api/admin/refusals`, { headers: await apiHeaders() });

    const data = await response.json();

    if (!response.ok) throw new Error(data?.error || 'Could not load blocked requests.');

    const items = data.refusals || [];
    const fresh = items.filter(item => !item.seen_at);

    list.innerHTML = '';

    if (note) {
      note.textContent =
        items.length
          ? `${items.length} in all, ${fresh.length} unread`
          : 'Nothing turned down yet';
    }

    section?.classList.remove('bad', 'warn', 'good');
    section?.classList.add(
      fresh.some(item => item.severity === 'high')
        ? 'bad'
        : fresh.length ? 'warn' : 'good'
    );

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'adminHint';
      empty.textContent = 'Natter has not turned anything down yet.';
      list.appendChild(empty);
      paintAdminMenu();
      return;
    }

    items.forEach(item => {

      const card = document.createElement('div');
      card.className = `refusalCard ${item.seen_at ? 'read' : item.severity === 'high' ? 'bad' : 'warn'}`;
      card.id = `refusal-${item.id}`;

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'refusalSummary';

      const dot = document.createElement('span');
      dot.className = 'refusalDot';
      head.appendChild(dot);

      const text = document.createElement('span');
      text.className = 'refusalSummaryText';

      const title = document.createElement('span');
      title.className = 'refusalTitle';
      title.textContent = item.category || 'Turned down';
      text.appendChild(title);

      if (item.kind) {
        const tag = document.createElement('span');
        tag.className = 'refusalKind';
        tag.textContent = item.kind;
        title.appendChild(tag);
      }

      const sub = document.createElement('span');
      sub.className = 'refusalSub';
      sub.textContent =
        [
          refusalWhen(item.created_at),
          item.name || (item.email ? item.email.split('@')[0] : 'guest'),
          item.email || ''
        ].filter(Boolean).join(' · ');
      text.appendChild(sub);

      head.appendChild(text);

      const chevron = document.createElement('span');
      chevron.className = 'refusalChevron';
      chevron.innerHTML =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>';
      head.appendChild(chevron);

      card.appendChild(head);

      const body = document.createElement('div');
      body.className = 'refusalBody';

      const row = (label, value, className = '') => {
        if (!value) return;
        const part = document.createElement('div');
        part.className = `refusalRow ${className}`.trim();
        const name = document.createElement('div');
        name.className = 'refusalLabel';
        name.textContent = label;
        const words = document.createElement('div');
        words.className = 'refusalText';
        words.textContent = value;
        part.appendChild(name);
        part.appendChild(words);
        body.appendChild(part);
      };

      row('They asked', item.request);
      row('Who', [item.name, item.email].filter(Boolean).join(' · ') || 'A guest, not signed in');
      row('What crossed the line', item.rule, 'breach');
      row('What would be fine to ask instead', item.avoid, 'fix');
      row('Natter replied', item.reply);

      const tools = document.createElement('div');
      tools.className = 'refusalTools';

      if (!item.seen_at) {
        const seen = document.createElement('button');
        seen.type = 'button';
        seen.className = 'adminAction adminQuiet';
        seen.textContent = 'Mark as read';
        seen.addEventListener('click', async () => {
          seen.disabled = true;
          try {
            await fetch(`${API_BASE}/api/admin/refusals/seen`, {
              method: 'POST',
              headers: await apiHeaders(),
              body: JSON.stringify({ id: item.id })
            });
            loadRefusals();
          } catch {
            seen.disabled = false;
          }
        });
        tools.appendChild(seen);
      }

      const lesson = document.createElement('button');
      lesson.type = 'button';
      lesson.className = 'adminAction adminQuiet';
      lesson.textContent = 'Copy for a house lesson';
      lesson.addEventListener('click', () => {
        navigator.clipboard?.writeText(`${item.category}: ${item.rule} Better: ${item.avoid}`);
        lesson.textContent = 'Copied';
        setTimeout(() => { lesson.textContent = 'Copy for a house lesson'; }, 1500);
      });
      tools.appendChild(lesson);

      body.appendChild(tools);
      card.appendChild(body);

      head.addEventListener('click', () => {
        const open = card.classList.toggle('open');
        if (open) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });

      list.appendChild(card);

    });

    paintAdminMenu();

  } catch (error) {

    adminSay('adminRefusalsResult', error.message, false);

  }

}

document.getElementById('refusalsClear')?.addEventListener('click', async event => {

  const button = event.currentTarget;

  button.disabled = true;

  try {

    await fetch(`${API_BASE}/api/admin/refusals/seen`, {
      method: 'POST',
      headers: await apiHeaders(),
      body: JSON.stringify({})
    });

    await loadRefusals();

    adminSay('adminRefusalsResult', 'All marked as read.', true);

  } catch (error) {

    adminSay('adminRefusalsResult', error.message, false);

  }

  button.disabled = false;

});


async function loadAdminUploads(reset = false) {

  const grid = document.getElementById('adminUploadGrid');
  const more = document.getElementById('adminUploadsMore');

  if (reset) {
    adminUploadOffset = 0;
    grid.innerHTML = '';
  }

  more.disabled = true;
  more.textContent = 'Loading...';

  try {

    const response =
      await fetch(`${API_BASE}/api/admin/uploads?offset=${adminUploadOffset}`, { headers: await apiHeaders() });

    const data = await response.json();

    if (!response.ok) throw new Error(data?.error || 'Could not load uploads.');

    adminUploadOffset += data.items.length;

    data.items.forEach(item => {

      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'artworkTile ready';

      if (item.url) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = 'Upload';
        img.src = item.url;
        tile.appendChild(img);
      }

      const caption = document.createElement('span');
      caption.className = 'artworkCaption';
      caption.textContent =
        `${item.who} · ${new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${({ ask: 'asked about', edit: 'edited', video: 'video' })[item.kind] || item.kind}`;
      tile.appendChild(caption);

      tile.addEventListener('click', () => {
        adminUploadViewing = { item, tile };
        const media = document.getElementById('adminUploadViewerMedia');
        media.innerHTML = '';
        if (item.url) {
          const img = document.createElement('img');
          img.src = item.url;
          img.alt = 'Upload';
          media.appendChild(img);
        }
        document.getElementById('adminUploadViewerMeta').textContent = caption.textContent;
        document.getElementById('adminUploadViewer').classList.add('show');
      });

      grid.appendChild(tile);

    });

    if (!grid.children.length) {
      grid.innerHTML = '<div class="artworkEmpty">No uploads yet.</div>';
    }

    document.getElementById('adminUploadsNote').textContent =
      data.total !== null && data.total !== undefined ? `${data.total} kept` : 'Every photo people upload';

    more.style.display = data.done ? 'none' : '';

  } catch (error) {

    adminSay('adminUploadsResult', error.message, false);

  } finally {

    more.disabled = false;
    more.textContent = 'Show more';

  }

}

document.getElementById('adminUploadsMore')?.addEventListener('click', () => loadAdminUploads(false));

document.getElementById('adminUploadViewerClose')?.addEventListener('click', () => {
  document.getElementById('adminUploadViewer').classList.remove('show');
});

document.getElementById('adminUploadDelete')?.addEventListener('click', async event => {

  if (!adminUploadViewing) return;

  const button = event.currentTarget;
  button.disabled = true;

  try {

    const response =
      await fetch(`${API_BASE}/api/admin/uploads/delete`, {
        method: 'POST',
        headers: await apiHeaders(),
        body: JSON.stringify({ id: adminUploadViewing.item.id })
      });

    const data = await response.json();

    if (!response.ok) throw new Error(data?.error || 'Could not remove it.');

    adminUploadViewing.tile.remove();
    document.getElementById('adminUploadViewer').classList.remove('show');
    adminSay('adminUploadsResult', 'Removed.', true);

  } catch (error) {

    adminSay('adminUploadsResult', error.message, false);

  } finally {

    button.disabled = false;

  }

});

/* =====================================================
   MY PROFILE: THE PICKER
===================================================== */

const PROFILE_PANEL_KEY = 'nastivee_profile_panel';

function profilePanels() {
  return [...document.querySelectorAll('#profilePanels > .foldCard')];
}

function panelTitle(panel) {
  if (panel.dataset.title) return panel.dataset.title;
  const text = panel.querySelector('.foldSummary .foldText');
  if (!text) return panel.id;
  const copy = text.cloneNode(true);
  copy.querySelectorAll('.foldNote').forEach(note => note.remove());
  return copy.textContent.replace(/\s+/g, ' ').trim() || panel.id;
}

function panelNote(panel) {
  return (panel.querySelector('.foldNote')?.textContent || '').trim();
}

function panelState(panel) {
  return ['bad', 'warn', 'good'].find(name => panel.classList.contains(name)) || '';
}

const PANEL_DOT = { good: '#4ade80', warn: '#f59e0b', bad: '#ef4444' };

function paintDot(dot, state) {
  dot.style.visibility = state ? '' : 'hidden';
  dot.style.background = PANEL_DOT[state] || 'transparent';
  dot.style.boxShadow = 'none';
}

function paintProfilePicker() {

  const panels = profilePanels();
  const current = panels.find(panel => panel.classList.contains('current')) || panels[0];

  if (!current) return;

  document.getElementById('profilePickerName').textContent = panelTitle(current);

  const pageName = document.getElementById('profilePageName');
  if (pageName) pageName.textContent = panelTitle(current);
  document.getElementById('profilePickerNote').textContent = panelNote(current);

  paintDot(document.getElementById('profilePickerDot'), panelState(current));

  /* the side menu, the same as the admin page and the home sidebar */
  const drawer = document.getElementById('profileDrawerList');

  if (drawer) {

    drawer.innerHTML = '';

    panels.forEach(panel => {

      const item = document.createElement('button');
      item.type = 'button';
      item.className = `adminNavItem ${panelState(panel)}${panel === current ? ' current' : ''}`;

      item.innerHTML =
        '<span class="adminNavDot" aria-hidden="true"></span>' +
        '<span class="adminNavText"><span class="adminNavName"></span><span class="adminNavNote"></span></span>';

      item.querySelector('.adminNavName').textContent = panelTitle(panel);
      item.querySelector('.adminNavNote').textContent = panelNote(panel);

      item.addEventListener('click', () => {
        showProfilePanel(panel.id);
        setProfilePicker(false);
      });

      drawer.appendChild(item);

    });

  }

  const list = document.getElementById('profilePickerList');
  list.innerHTML = '';

  panels.forEach(panel => {

    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.className = `profilePickerItem${panel === current ? ' current' : ''}`;

    item.innerHTML =
      '<span class="foldDot" aria-hidden="true"></span>' +
      '<span class="profilePickerText"><span class="profilePickerName"></span><span class="profilePickerNote"></span></span>';

    paintDot(item.querySelector('.foldDot'), panelState(panel));
    item.querySelector('.profilePickerName').textContent = panelTitle(panel);
    item.querySelector('.profilePickerNote').textContent = panelNote(panel);

    item.addEventListener('click', event => {
      event.stopPropagation();
      showProfilePanel(panel.id);
      setProfilePicker(false);
    });

    list.appendChild(item);

  });

}

function showProfilePanel(id) {

  const panels = profilePanels();
  const target = panels.find(panel => panel.id === id) || panels[0];

  if (!target) return;

  panels.forEach(panel => {
    const on = panel === target;
    panel.classList.toggle('current', on);
    panel.classList.toggle('open', on);
  });

  try { localStorage.setItem(PROFILE_PANEL_KEY, target.id); } catch {}

  document.getElementById('profilePanels').scrollTop = 0;

  paintProfilePicker();

}

function setProfilePicker(open) {
  const picker = document.getElementById('profilePicker');
  picker.classList.toggle('open', open);
  document.getElementById('profileOverlay')?.classList.toggle('drawerOpen', open);
  document.getElementById('profilePickerButton').setAttribute('aria-expanded', open ? 'true' : 'false');
  document.getElementById('profileBurger')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) paintProfilePicker();
}

document.getElementById('profileBurger')?.addEventListener('click', event => {
  event.stopPropagation();
  setProfilePicker(!document.getElementById('profilePicker').classList.contains('open'));
});

document.getElementById('profileShade')?.addEventListener('click', () => setProfilePicker(false));

document.getElementById('profileDrawerShade')?.addEventListener('click', () => setProfilePicker(false));

document.getElementById('profilePickerButton')?.addEventListener('click', event => {
  event.stopPropagation();
  setProfilePicker(!document.getElementById('profilePicker').classList.contains('open'));
});

document.addEventListener('click', event => {
  if (!event.target.closest?.('#profilePicker, #profileBurger')) setProfilePicker(false);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.getElementById('profilePicker').classList.contains('open')) {
    setProfilePicker(false);
  }
});

/* notes and colours change as things load: keep the picker in step */
if (window.MutationObserver) {
  new MutationObserver(() => paintProfilePicker())
    .observe(document.getElementById('profilePanels'), { subtree: true, attributes: true, attributeFilter: ['class'], characterData: true, childList: true });
}

(() => {
  let last = null;
  try { last = localStorage.getItem(PROFILE_PANEL_KEY); } catch {}
  showProfilePanel(last || 'foldAbout');
})();

/* =====================================================
   HELP ME WORD THIS

   The wand turns a rough idea into a clear request. After
   a refusal, one tap asks for a version that genuinely fits
   the rules, which lands in the box for them to check.
===================================================== */

const wordButton = document.getElementById('wordButton');
const wordNote = document.getElementById('wordNote');

let wordBefore = null;

function paintWordButton() {
  wordButton?.classList.toggle('show', (messageInput.value || '').trim().length >= 4);
}

messageInput.addEventListener('input', () => {
  paintWordButton();
  if (wordNote.classList.contains('show') && !wordButton.classList.contains('busy')) {
    wordNote.classList.remove('show');
  }
});

function currentWordKind() {
  if (typeof videoMode !== 'undefined' && videoMode) return 'video';
  if (imageMode) return 'image';
  if (selectedImageData) return 'edit';
  return 'chat';
}

async function rewordRequest(text, kind, refused = false) {

  const response =
    await fetch(`${API_BASE}/api/prompt/improve`, {
      method: 'POST',
      headers: await apiHeaders(),
      body: JSON.stringify({ text, kind, refused })
    });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) throw new Error(data.error || 'Could not reword that just now.');

  return data;

}

function showWordNote(text) {
  document.getElementById('wordNoteText').textContent = text;
  wordNote.classList.add('show');
}

wordButton?.addEventListener('click', async () => {

  const draft = messageInput.value.trim();

  if (!draft || wordButton.classList.contains('busy')) return;

  wordButton.classList.add('busy');

  try {

    const result = await rewordRequest(draft, currentWordKind());

    if (!result.text) {
      showWordNote(result.note || 'Nothing acceptable could be made of that one. Try a different idea.');
      return;
    }

    wordBefore = draft;
    messageInput.value = result.text;
    resizeTextarea();
    showWordNote(result.note ? `Reworded. ${result.note}` : 'Reworded. Check it over, then send.');
    messageInput.focus();

  } catch (error) {

    showWordNote(error.message);

  } finally {

    wordButton.classList.remove('busy');
    paintWordButton();

  }

});

document.getElementById('wordUndo')?.addEventListener('click', () => {
  if (wordBefore !== null) {
    messageInput.value = wordBefore;
    resizeTextarea();
    wordBefore = null;
  }
  wordNote.classList.remove('show');
  paintWordButton();
});

/* after a refusal: offer a version that actually fits */
function offerFittingVersion(chatId, prompt, kind, errorText) {

  if (!prompt || !/safety system|safety_violations|content policy|moderation|blocked by the safety|raiMediaFiltered|safety rules/i.test(String(errorText || ''))) return;

  if (!isCurrentChat(chatId)) return;

  const rows = chat.querySelectorAll('.messageRow.assistant');
  const last = rows[rows.length - 1];
  const holder = last?.querySelector('.bubbleWrap') || last;

  if (!holder) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fitButton';
  button.textContent = 'Suggest a version that works';

  button.addEventListener('click', async () => {

    button.disabled = true;
    button.textContent = 'Thinking...';

    try {

      const result = await rewordRequest(prompt, kind, true);

      if (!result.text) {
        button.textContent = 'Nothing acceptable could be made of that one';
        return;
      }

      if (kind === 'image') setImageMode(true);
      if (kind === 'video' && typeof setVideoMode === 'function') setVideoMode(true);

      messageInput.value = result.text;
      resizeTextarea();
      paintWordButton();

      wordBefore = null;

      showWordNote(
        (result.note ? `${result.note} ` : '') +
        (kind === 'edit' ? 'Attach the photo again with Edit Photo, then send.' : 'Check it over, then send.')
      );

      messageInput.focus();
      button.remove();

    } catch (error) {

      button.disabled = false;
      button.textContent = 'Suggest a version that works';
      showWordNote(error.message);

    }

  });

  holder.appendChild(button);

}

paintWordButton();

/* =====================================================
   SIDEBAR AUTO HIDE: taps
   Pointing at the edge opens it on a computer; on touch
   screens a tap on the glowing edge does, and a tap on the
   page tucks it away again.
===================================================== */

sidebar.addEventListener('click', event => {

  const wide = window.matchMedia('(min-width: 761px)').matches;

  /* only real taps and clicks; buttons pressed by the app itself go straight through */
  if (!event.isTrusted || document.body.classList.contains('sidebarPinned')) return;

  if (wide) {
    if (!sidebar.classList.contains('peekOpen') && !sidebar.matches(':hover')) {
      event.preventDefault();
      event.stopPropagation();
      sidebar.classList.add('peekOpen');
    }
    return;
  }

}, true);

document.addEventListener('pointerdown', event => {
  if (sidebar.classList.contains('peekOpen') && !sidebar.contains(event.target)) {
    sidebar.classList.remove('peekOpen');
  }
});

sidebar.addEventListener('mouseleave', () => sidebar.classList.remove('peekOpen'));

/* each computer chooses: keep the sidebar open, or let it tuck away */
const PIN_KEY = 'natter_sidebar_pinned';

function paintPin() {
  const pinned = document.body.classList.contains('sidebarPinned');
  const button = document.getElementById('pinSidebar');
  if (!button) return;
  button.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  document.getElementById('pinSidebarLabel').textContent = pinned ? 'Auto hide' : 'Keep open';
  button.title = pinned ? 'Let the sidebar tuck away when not in use' : 'Keep the sidebar open all the time';
}

try { document.body.classList.toggle('sidebarPinned', localStorage.getItem(PIN_KEY) === '1'); } catch {}

paintPin();

document.getElementById('pinSidebar')?.addEventListener('click', () => {
  const pinned = !document.body.classList.contains('sidebarPinned');
  document.body.classList.toggle('sidebarPinned', pinned);
  sidebar.classList.remove('peekOpen');
  try { localStorage.setItem(PIN_KEY, pinned ? '1' : '0'); } catch {}
  paintPin();
});

/* =====================================================
   SEND BUTTON
===================================================== */

sendButton.addEventListener(
  'click',
  sendMessage
);


/* =====================================================
   IMAGE MODE
===================================================== */

function setImageMode(
  enabled
) {

  imageMode =
    Boolean(enabled);

  if (imageMode && videoMode) {
    setVideoMode(false);
  }

  /* the shape picker belongs to Create image (and video) */
  shapeRow.classList.toggle('show', imageMode);
  shapeRow.classList.remove('videoShapes');


  if (imageMode) {

    messageInput.placeholder =
      'Describe the image you want me to create...';


    imageButton.classList.add(
      'imageModeActive'
    );


    imageButton.title =
      'Image mode on — press again to turn off';


    imageButton.setAttribute(
      'aria-pressed',
      'true'
    );


  } else {

    messageInput.placeholder =
      selectedImageData
        ? 'Ask about it, or say what to change...'
        : 'Message Natter...';


    imageButton.classList.remove(
      'imageModeActive'
    );


    imageButton.title =
      'Create image';


    imageButton.setAttribute(
      'aria-pressed',
      'false'
    );

  }

}


/* =====================================================
   IMAGE BUTTON
===================================================== */

imageButton.addEventListener(
  'click',
  () => {

    if (guestImagesBlocked()) {
      return;
    }


    /*
      If an image is uploaded, the button
      should not accidentally switch to
      generation mode.

      The text box is already in edit mode.
    */

    if (selectedImageData) {

      messageInput.focus();

      return;

    }


    setImageMode(
      !imageMode
    );


    messageInput.focus();

  }
);


/* =====================================================
   UPLOAD BUTTON
===================================================== */

uploadButton.addEventListener(
  'click',
  () => {

    if (guestImagesBlocked()) {
      return;
    }

    fileInput.click();

  }
);


/* =====================================================
   FILE UPLOAD
===================================================== */

/* =====================================================
   PREPARING AN UPLOAD

   Every photo is redrawn in the browser before it goes
   anywhere: turned the right way up, shrunk so its longest
   side is at most 1600px, and saved as a JPEG (or a PNG
   when it has see-through parts). That keeps uploads small
   and fast, turns odd formats into ones every model reads,
   and drops the hidden details phones add, like where the
   photo was taken.
===================================================== */

const UPLOAD_MAX_SIDE = 1600;

async function decodeImageFile(file) {

  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {}
  }

  const url = URL.createObjectURL(file);

  try {

    const img = new Image();

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });

    return img;

  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

}

async function prepareUpload(file) {

  let source;

  try {
    source = await decodeImageFile(file);
  } catch {
    throw new Error(
      'That photo could not be opened here. Try a JPEG or PNG. ' +
      'On an iPhone: Settings, Camera, Formats, Most Compatible.'
    );
  }

  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;

  if (!width || !height) {
    throw new Error('That photo looks empty. Try another one.');
  }

  const scale = Math.min(1, UPLOAD_MAX_SIDE / Math.max(width, height));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  source.close?.();

  /* only formats that can be see-through are checked for it */
  let transparent = false;

  if (/png|webp|gif|avif/i.test(file.type || file.name)) {

    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const step = Math.max(4, Math.floor(data.length / 4 / 40000) * 4);

    for (let i = 3; i < data.length; i += step) {
      if (data[i] < 250) { transparent = true; break; }
    }

  }

  const dataUrl =
    transparent
      ? canvas.toDataURL('image/png')
      : canvas.toDataURL('image/jpeg', 0.86);

  return {
    dataUrl,
    width: canvas.width,
    height: canvas.height,
    resized: scale < 1
  };

}


fileInput.addEventListener(
  'change',
  async event => {

    const picked =
      [...(event.target.files || [])];


    if (!picked.length) {
      return;
    }


    const room = Math.max(0, 4 - selectedImages.length);

    if (!room) {

      addTextMessage('assistant', 'That is four photos already, which is the most I can take at once.');

      fileInput.value = '';

      return;

    }

    let added = 0;

    for (const file of picked.slice(0, room)) {

      const looksLikeImage =
        (file.type || '').startsWith('image/') ||
        /\.(heic|heif|jpe?g|png|webp|gif|avif|bmp)$/i.test(file.name || '');

      if (!looksLikeImage) {

        addTextMessage('assistant', `${file.name || 'That file'} is not a photo. Upload pictures (JPEG, PNG, HEIC and the like).`);

        continue;

      }

      let prepared;

      try {

        prepared = await prepareUpload(file);

      } catch (error) {

        addTextMessage('assistant', error.message);

        continue;

      }

      selectedImageFile = file;

      selectedImages.push({ data: prepared.dataUrl, name: file.name });

      added += 1;

    }

    fileInput.value = '';

    if (!added) return;

    if (picked.length > room) {
      addTextMessage('assistant', 'I can take four photos at a time, so I have kept the first four.');
    }

    {

        paintUploads();


        imageMode =
          false;


        imageButton.classList.add(
          'imageModeActive'
        );


        imageButton.title =
          'Image uploaded — describe the edit';


        messageInput.placeholder =
          selectedImages.length > 1
            ? 'Ask about them, or say what to make from them...'
            : 'Ask about it, or say what to change...';


        messageInput.focus();

    }

  }
);


/* =====================================================
   CLEAR UPLOAD
===================================================== */

clearUploadButton.addEventListener(
  'click',
  clearUpload
);


function clearUpload() {

  photoAction = 'edit';

  photoActionChosen = false;

  /* neither is picked: the words decide, unless they tap one */
  [...photoChoice.children].forEach(item => {
    item.classList.remove('active');
  });


  selectedImageFile =
    null;

  selectedImageData =
    null;

  selectedImages = [];


  fileInput.value =
    '';


  if (uploadThumbs) uploadThumbs.innerHTML = '';

  uploadName.textContent =
    '';


  uploadPreview.classList.remove(
    'show'
  );


  imageButton.classList.remove(
    'imageModeActive'
  );


  setImageMode(
    false
  );

}


/* =====================================================
   TEXTAREA
===================================================== */

messageInput.addEventListener(
  'input',
  resizeTextarea
);


function resizeTextarea() {

  messageInput.style.height =
    'auto';


  messageInput.style.height =
    Math.min(
      messageInput.scrollHeight,
      180
    ) + 'px';

  /* the wand only shows when there is something to reword */
  try { paintWordButton(); } catch {}

}


/* =====================================================
   ENTER TO SEND
===================================================== */

messageInput.addEventListener(
  'keydown',
  event => {

    if (
      event.key === 'Enter' &&
      !event.shiftKey
    ) {

      event.preventDefault();

      sendMessage();

    }

  }
);


/* =====================================================
   SCROLL
===================================================== */

/*
  Only follow the conversation down while the user is
  already at the bottom. If they have scrolled up to read
  something, leave them there and offer a way back.
*/

function nearBottom() {

  return (
    chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120
  );

}

function scrollToBottom(force = false) {

  if (!force && !nearBottom()) {

    jumpButton.classList.add('show');

    return;

  }

  requestAnimationFrame(
    () => {

      chat.scrollTop =
        chat.scrollHeight;

      jumpButton.classList.remove('show');

    }
  );

}

chat.addEventListener('scroll', () => {

  jumpButton.classList.toggle(
    'show',
    !nearBottom()
  );

});

jumpButton.addEventListener(
  'click',
  () => scrollToBottom(true)
);


/* =====================================================
   DOWNLOAD IMAGE
===================================================== */

async function downloadImage(
  imageRef
) {

  if (!imageRef) {
    return;
  }

  let imageData;

  try {
    imageData = await resolveImage(imageRef);
  } catch (error) {
    console.error('SAVE ERROR:', error);
    return;
  }


  const link =
    document.createElement(
      'a'
    );

  link.href =
    imageData;

  link.download =
    `natter-image-${Date.now()}.png`;


  document.body.appendChild(
    link
  );

  link.click();

  link.remove();

}


/* =====================================================
   LOGOUT
===================================================== */

logoutButton.addEventListener(
  'click',
  async () => {

    if (guestMode) {

      stopPresence();

      stopGuestMode();

      imageState.clear();

      initialised = false;

      showAuth();

      return;

    }

    stopPresence();

    await supabaseClient.auth.signOut();

    creditsRow?.classList.remove('show');

    currentUser =
      null;

    currentChatId =
      null;

    chats =
      [];

    imageState.clear();

    initialised =
      false;

    showAuth();

  }
);


/* =====================================================
   WHO IS ONLINE

   A Supabase realtime presence channel. Everyone in the
   app joins it, signed in or guest, and the header shows
   how many are connected right now.
===================================================== */

let presenceChannel = null;

function onlineLabel(count) {

  if (count <= 1) {
    return 'Just you online';
  }

  return `${count} online`;

}

/*
  The count shows in the app header and on the login
  screen, so it is visible whether or not you are in.
*/

const statusLabels = () =>
  [
    onlineCountLabel,
    document.getElementById('authOnlineCount')
  ].filter(Boolean);

const shortLabel = () =>
  document.getElementById('onlineShort');

const statusDots = () =>
  [
    statusDot,
    document.getElementById('authStatusDot')
  ].filter(Boolean);

function setOnlineCount(count) {

  const text = onlineLabel(count);

  statusLabels().forEach(el => {
    el.textContent = text;
  });

  const short = shortLabel();

  if (short) {
    short.textContent = String(count);
    short.title = text;
  }

  statusDots().forEach(dot => {
    dot.classList.remove('offline');
  });

}

function setOffline() {

  statusLabels().forEach(el => {
    el.textContent = 'Offline';
  });

  const short = shortLabel();

  if (short) {
    short.textContent = '-';
    short.title = 'Offline';
  }

  statusDots().forEach(dot => {
    dot.classList.add('offline');
  });

}

function startPresence() {

  if (presenceChannel) {
    return;
  }


  const who =
    currentUser?.id ||
    `guest-${Math.random().toString(36).slice(2, 10)}`;


  try {

    presenceChannel =
      supabaseClient.channel(
        'nastivee-online',
        {
          config: {
            presence: { key: who }
          }
        }
      );

    presenceChannel.on(
      'presence',
      { event: 'sync' },
      () => {

        const state =
          presenceChannel.presenceState();

        setOnlineCount(
          Object.keys(state || {}).length
        );

      }
    );

    presenceChannel.subscribe(async status => {

      if (status === 'SUBSCRIBED') {

        await presenceChannel.track({
          online_at: new Date().toISOString(),
          guest: guestMode
        });

      } else if (
        status === 'CHANNEL_ERROR' ||
        status === 'TIMED_OUT'
      ) {

        setOffline();

      }

    });

  } catch (error) {

    console.error('PRESENCE ERROR:', error);

    setOffline();

  }

}

function stopPresence() {

  if (!presenceChannel) {
    return;
  }

  try {
    supabaseClient.removeChannel(presenceChannel);
  } catch {}

  presenceChannel = null;

}

const offlineBar =
  document.getElementById('offlineBar');

function paintConnection() {

  offlineBar.classList.toggle(
    'show',
    navigator.onLine === false
  );

}

window.addEventListener('online', paintConnection);
window.addEventListener('offline', paintConnection);

paintConnection();


window.addEventListener('offline', setOffline);

window.addEventListener('online', () => {
  stopPresence();
  startPresence();
});


/* =====================================================
   APP VERSION / CACHE BUSTING

   Bump APP_VERSION on every deploy. The service worker
   registration carries it, so the browser always sees a
   changed worker, installs it, and this page reloads
   itself once so the user is on the new version without
   clearing anything by hand.
===================================================== */

const APP_VERSION = window.NASTIVEE_VERSION || 'dev';

const RELOAD_FLAG = 'nastivee_reloaded_for';

/* the build this device is running, shown beside the email */
versionTag.textContent =
  (() => {
    const [, month, day, build] =
      APP_VERSION.split('-').map(Number);
    return `v${month}.${day}.${build}`;
  })();

versionTag.title = `Version ${APP_VERSION}`;

if ('serviceWorker' in navigator) {

  window.addEventListener('load', () => {

    navigator.serviceWorker
      .register(`./sw.js?v=${APP_VERSION}`)
      .then(registration => {

        // Look for a newer worker whenever the app is opened
        registration.update().catch(() => {});

        registration.addEventListener('updatefound', () => {

          const installing = registration.installing;

          if (!installing) return;

          installing.addEventListener('statechange', () => {

            if (
              installing.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {

              reloadForNewVersion();

            }

          });

        });

      })
      .catch(() => {});


    // A new worker took over this page
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      reloadForNewVersion
    );

  });

}


/*
  Reload at most once per version, so a worker that keeps
  updating can never put the app in a reload loop.
*/
function reloadForNewVersion() {

  let already = null;

  try {
    already = sessionStorage.getItem(RELOAD_FLAG);
  } catch {}

  if (already === APP_VERSION) {
    return;
  }

  try {
    sessionStorage.setItem(RELOAD_FLAG, APP_VERSION);
  } catch {}

  window.location.reload();

}


/* =====================================================
   START
===================================================== */

updateAuthMode();

resizeTextarea();

checkSession();

