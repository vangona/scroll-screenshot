document.addEventListener('DOMContentLoaded', () => {
  const urlsInput = document.getElementById('urls');
  const delayInput = document.getElementById('delay');
  const formatSelect = document.getElementById('format');
  const clickSelectorInput = document.getElementById('clickSelector');
  const scrollWaitInput = document.getElementById('scrollWait');
  const viewportSelect = document.getElementById('viewport');
  const startBtn = document.getElementById('startBtn');
  const progressSection = document.getElementById('progress');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const logSection = document.getElementById('log');
  const queueSection = document.getElementById('queueSection');
  const queueUrls = document.getElementById('queueUrls');
  const updateQueueBtn = document.getElementById('updateQueueBtn');
  const addUrls = document.getElementById('addUrls');
  const addQueueBtn = document.getElementById('addQueueBtn');

  const msg = chrome.i18n.getMessage;

  // Apply i18n to DOM elements
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = msg(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = msg(el.dataset.i18nPlaceholder);
  });

  let isCapturing = false;

  // Sync state with background on popup open
  chrome.runtime.sendMessage({ action: 'getState' }, (state) => {
    if (chrome.runtime.lastError || !state) return;
    if (state.isRunning) {
      setCapturingState();
      updateProgress(state.totalProcessed, state.total);
      updateQueueDisplay(state.remainingQueue);
    }
  });

  // Parse and validate URLs
  function parseUrls(text) {
    return text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .filter(line => {
        try {
          const url = new URL(line);
          return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
          return false;
        }
      });
  }

  // Add log entry (using safe DOM methods)
  function addLog(message, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = message; // Safe: textContent escapes HTML
    logSection.appendChild(entry);
    logSection.scrollTop = logSection.scrollHeight;
  }

  // Clear logs (using safe DOM method)
  function clearLogs() {
    while (logSection.firstChild) {
      logSection.removeChild(logSection.firstChild);
    }
  }

  // Update progress
  function updateProgress(current, total) {
    const percentage = total > 0 ? (current / total) * 100 : 0;
    progressFill.style.width = `${percentage}%`;
    progressText.textContent = `${current} / ${total}`;
  }

  // Update queue display
  function updateQueueDisplay(remainingQueue) {
    if (remainingQueue && remainingQueue.length > 0) {
      queueUrls.value = remainingQueue.join('\n');
    } else {
      queueUrls.value = '';
    }
  }

  // Switch to capturing UI state
  function setCapturingState() {
    isCapturing = true;
    startBtn.disabled = false;
    startBtn.textContent = msg('stop');
    startBtn.classList.add('stop-mode');
    progressSection.style.display = 'block';
    queueSection.style.display = 'block';
  }

  // Switch to idle UI state
  function setIdleState() {
    isCapturing = false;
    startBtn.disabled = false;
    startBtn.textContent = msg('startCapture');
    startBtn.classList.remove('stop-mode');
    queueSection.style.display = 'none';
  }

  // Start capture
  startBtn.addEventListener('click', async () => {
    if (isCapturing) {
      // Stop capture
      startBtn.disabled = true;
      startBtn.textContent = msg('stopping');
      try {
        await chrome.runtime.sendMessage({ action: 'stopCapture' });
        addLog(msg('logStopRequested'), 'info');
      } catch (error) {
        addLog(msg('logStopError', [error.message]), 'error');
      }
      // If this popup didn't initiate the capture, transition to idle after stop
      setTimeout(async () => {
        try {
          const state = await chrome.runtime.sendMessage({ action: 'getState' });
          if (state && !state.isRunning) {
            setIdleState();
          }
        } catch (e) { /* ignore */ }
      }, 3000);
      return;
    }

    const urls = parseUrls(urlsInput.value);

    if (urls.length === 0) {
      alert(msg('alertNoUrl'));
      return;
    }

    const options = {
      delay: parseInt(delayInput.value, 10) || 1000,
      format: formatSelect.value,
      clickSelector: clickSelectorInput.value.trim() || null,
      scrollWait: parseInt(scrollWaitInput.value, 10) || 5000,
      viewport: viewportSelect.value
    };

    setCapturingState();
    clearLogs();
    updateProgress(0, urls.length);
    addUrls.value = '';

    addLog(msg('logStartCapture', [String(urls.length)]), 'info');

    try {
      // Send message to background script
      const response = await chrome.runtime.sendMessage({
        action: 'captureScreenshots',
        urls: urls,
        options: options
      });

      if (response.stopped) {
        addLog(msg('logStopped'), 'info');
      } else if (response.success) {
        addLog(msg('logAllCompleted'), 'success');
      } else {
        addLog(msg('logCaptureFinished', [response.error]), 'error');
      }
    } catch (error) {
      addLog(msg('logError', [error.message]), 'error');
    }

    setIdleState();
  });

  // Update queue button
  updateQueueBtn.addEventListener('click', async () => {
    const urls = parseUrls(queueUrls.value);
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'updateQueue',
        urls: urls
      });
      if (response.success) {
        addLog(msg('logQueueUpdated', [String(response.queueLength)]), 'info');
        updateProgress(response.total - response.queueLength, response.total);
      } else {
        addLog(msg('logUpdateFailed', [response.error]), 'error');
      }
    } catch (error) {
      addLog(msg('logUpdateError', [error.message]), 'error');
    }
  });

  // Add to queue button
  addQueueBtn.addEventListener('click', async () => {
    const urls = parseUrls(addUrls.value);
    if (urls.length === 0) {
      alert(msg('alertNoAddUrl'));
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'addToQueue',
        urls: urls
      });
      if (response.success) {
        addUrls.value = '';
        addLog(msg('logAdded', [String(urls.length), String(response.queueLength)]), 'info');
        updateProgress(response.total - response.queueLength, response.total);
      } else {
        addLog(msg('logAddFailed', [response.error]), 'error');
      }
    } catch (error) {
      addLog(msg('logAddError', [error.message]), 'error');
    }
  });

  // Listen for progress updates from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'progressUpdate') {
      updateProgress(message.current, message.total);
      addLog(message.message, message.type || 'info');
      if (message.remainingQueue) {
        updateQueueDisplay(message.remainingQueue);
      }
      // Detect capture stopped or completed
      if (message.message === msg('bgStoppedByUser') ||
          (message.current === message.total && message.total > 0 && (!message.remainingQueue || message.remainingQueue.length === 0))) {
        setIdleState();
      }
    }
    return true;
  });
});
