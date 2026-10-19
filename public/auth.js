(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var path = location.pathname.replace(/\/+$/, '') || '/';
  var VIEWS = { '/login': 'login', '/register': 'register', '/forgot-password': 'forgot', '/reset-password': 'reset' };
  var TITLES = { login: 'Log in', register: 'Create account', forgot: 'Reset password', reset: 'New password' };
  var view = VIEWS[path] || 'login';
  $('#v-' + view).hidden = false;
  document.title = TITLES[view] + ' · InvestBrick';

  function banner(kind, text) { var b = $('#banner'); b.className = 'alert ' + kind; b.textContent = text; b.hidden = false; }

  function api(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); },
        function () { return { ok: false, status: 0, body: { error: 'Cannot reach the server. Check your connection and try again.' } }; });
  }
  function setBusy(form, busy, label) {
    var b = $('.btn', form), l = $('.lbl', b);
    b.disabled = busy; b.setAttribute('aria-busy', busy);
    if (busy) { b.dataset.label = l.textContent; l.textContent = label; var s = document.createElement('span'); s.className = 'spin'; b.insertBefore(s, l); }
    else { var sp = $('.spin', b); if (sp) sp.remove(); if (b.dataset.label) l.textContent = b.dataset.label; }
  }
  function clearErrors(form) {
    form.querySelectorAll('.err').forEach(function (e) { e.textContent = ''; });
    form.querySelectorAll('input').forEach(function (i) { i.removeAttribute('aria-invalid'); });
    var f = form.querySelector('[id^="e-form"]'); f.className = ''; f.textContent = '';
  }
  function fieldError(form, name, msg) {
    var el = form.querySelector('.err[data-for="' + name + '"]'), inp = form.querySelector('[name="' + name + '"]');
    if (el) el.textContent = msg; if (inp) inp.setAttribute('aria-invalid', 'true');
  }
  function formError(form, msg) { var f = form.querySelector('[id^="e-form"]'); f.className = 'alert bad'; f.textContent = msg; }
  function showFieldErrors(form, fields) {
    var first = null;
    Object.keys(fields || {}).forEach(function (k) { fieldError(form, k, fields[k]); first = first || form.querySelector('[name="' + k + '"]'); });
    if (first) first.focus();
  }
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

  // show/hide password
  document.querySelectorAll('[data-eye]').forEach(function (b) {
    b.addEventListener('click', function () {
      var i = document.getElementById(b.getAttribute('data-eye')), show = i.type === 'password';
      i.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });
  // strength meter (guidance only; the server enforces the real rules)
  function score(pw) {
    if (!pw) return 0;
    var classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(function (r) { return r.test(pw); }).length;
    if (pw.length < 10) return 1;
    if (pw.length >= 20 || (pw.length >= 14 && classes >= 3)) return 4;
    if (pw.length >= 12 && classes >= 2) return 3;
    return 2;
  }
  [['r-pw', 'meter'], ['x-pw', 'meter2']].forEach(function (p) {
    var i = document.getElementById(p[0]); if (i) i.addEventListener('input', function () { document.getElementById(p[1]).setAttribute('data-s', score(i.value)); });
  });

  function submit(formId, busyLabel, validate, call, done) {
    var form = $(formId); if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault(); if ($('.btn', form).disabled) return;
      clearErrors(form);
      var data = {}; new FormData(form).forEach(function (v, k) { data[k] = v; });
      var errs = validate(data);
      if (errs) { showFieldErrors(form, errs); return; }
      setBusy(form, true, busyLabel);
      call(data).then(function (res) {
        setBusy(form, false);
        if (res.ok) return done(res.body, form);
        if (res.body.fields) showFieldErrors(form, res.body.fields);
        formError(form, res.body.error || 'Something went wrong. Please try again.');
      });
    });
  }

  submit('#f-login', 'Logging in…', function (d) {
    var e = {}; if (!EMAIL_RE.test(d.email.trim())) e.email = 'Enter a valid email address.'; if (!d.password) e.password = 'Enter your password.';
    return Object.keys(e).length ? e : null;
  }, function (d) { return api('/api/auth/login', d); }, function () { location.assign('/'); });

  submit('#f-register', 'Creating account…', function (d) {
    var e = {}; if (!d.name.trim()) e.name = 'Enter your name.'; if (!EMAIL_RE.test(d.email.trim())) e.email = 'Enter a valid email address.';
    if (d.password.length < 10) e.password = 'Use at least 10 characters.';
    return Object.keys(e).length ? e : null;
  }, function (d) { return api('/api/auth/register', d); }, function () { location.assign('/'); });

  submit('#f-forgot', 'Sending…', function (d) {
    return EMAIL_RE.test(d.email.trim()) ? null : { email: 'Enter a valid email address.' };
  }, function (d) { return api('/api/auth/forgot-password', d); }, function (body, form) {
    form.hidden = true; $('.alt', $('#v-forgot')).hidden = false;
    banner('good', body.message || 'If an account exists for that email, a reset link is on its way.');
  });

  // reset: the token travels in the URL fragment, which browsers never send to servers or in Referer headers.
  var token = '';
  if (view === 'reset') {
    var m = /(?:^#|&)token=([^&]+)/.exec(location.hash); token = m ? decodeURIComponent(m[1]) : '';
    history.replaceState(null, '', location.pathname);
    if (!token) { $('#f-reset').hidden = true; banner('bad', 'This reset link is incomplete. Open the link from your email again, or request a new one.'); }
  }
  submit('#f-reset', 'Updating…', function (d) {
    return d.password.length < 10 ? { password: 'Use at least 10 characters.' } : null;
  }, function (d) { return api('/api/auth/reset-password', { token: token, password: d.password }); }, function (body, form) {
    form.hidden = true; token = '';
    banner('good', body.message || 'Password updated.');
    var a = document.createElement('a'); a.href = '/login'; a.className = 'btn'; a.style.textDecoration = 'none'; a.textContent = 'Go to log in'; $('#v-reset').insertBefore(a, $('.alt', $('#v-reset')));
  });

  // if the server has no database configured, say so plainly instead of failing on submit
  fetch('/api/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
    if (j && j.enabled === false) {
      banner('warn', 'Accounts are not set up on this server yet (no database is configured). You can still use InvestBrick as a guest.');
      document.querySelectorAll('form .btn').forEach(function (b) { b.disabled = true; });
    }
  }).catch(function () {});
})();
