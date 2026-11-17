/* EduGenesis OS — the learner screen.
 *
 * Three rules govern this file:
 *
 *   1. The server is the only source of a lesson. Nothing is composed or
 *      cached here; the page renders exactly the text the API returned.
 *   2. The request state is announced through the live region, and the lesson
 *      itself is announced by moving focus to the card once it is filled.
 *      Announcing "ready" while the text sits silently elsewhere makes a
 *      screen-reader user hunt for the thing they asked for.
 *   3. A suggestion is a shortcut, never a different code path: it fills the
 *      real input and submits the real form.
 */
(function () {
  'use strict';

  var form = document.getElementById('ask-form');
  var input = document.getElementById('question');
  var button = document.getElementById('ask-button');
  var status = document.getElementById('status');
  var section = document.getElementById('answer-section');
  var answer = document.getElementById('answer');
  var answerText = document.getElementById('answer-text');
  var emptyState = document.getElementById('answer-empty');
  var suggestions = document.getElementById('suggestions');

  function say(message, tone) {
    status.textContent = message;
    if (tone) {
      status.setAttribute('data-tone', tone);
    } else {
      status.removeAttribute('data-tone');
    }
  }

  function setBusy(isBusy) {
    button.disabled = isBusy;
    if (isBusy) {
      section.setAttribute('aria-busy', 'true');
    } else {
      section.removeAttribute('aria-busy');
    }
  }

  function clearAnswer() {
    answer.hidden = true;
    answerText.textContent = '';
  }

  function ask(question) {
    setBusy(true);
    clearAnswer();
    say('Preparing your lesson…');

    fetch('/api/learn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: question }),
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { ok: response.ok, payload: payload };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          say(
            result.payload && result.payload.error
              ? result.payload.error
              : 'A lesson is not available right now.',
            'error',
          );
          clearAnswer();
          input.focus();
          return;
        }
        answerText.textContent = result.payload.text;
        answer.hidden = false;
        if (emptyState) emptyState.hidden = true;
        say('Your lesson is ready.', 'ok');
        // The card is the announcement: it carries the heading and the text,
        // so focus delivers the lesson itself rather than a bare "ready".
        answer.focus();
      })
      .catch(function () {
        say('A lesson is not available right now. Please try again shortly.', 'error');
        clearAnswer();
      })
      .then(function () {
        setBusy(false);
      });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var question = input.value.trim();
    if (question.length === 0) {
      say('Type a question first.', 'error');
      input.focus();
      return;
    }
    ask(question);
  });

  if (suggestions) {
    suggestions.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || target.nodeName !== 'BUTTON') return;
      var question = target.getAttribute('data-question');
      if (!question) return;
      input.value = question;
      ask(question);
    });
  }
})();
