// Full Page Screenshot - Background Service Worker

// Global capture state for queue management
let captureState = {
  isRunning: false,
  isStopped: false,
  queue: [],
  totalProcessed: 0,
  totalOriginal: 0,
  options: null
};

// Send command to debugger
function sendDebuggerCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

// Wait for page to fully load
function waitForPageLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Delay helper
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Generate filename from URL
function generateFilename(url, format) {
  try {
    const urlObj = new URL(url);
    let filename = urlObj.hostname + urlObj.pathname;
    filename = filename.replace(/[^a-zA-Z0-9]/g, '_');
    filename = filename.replace(/_+/g, '_');
    filename = filename.replace(/^_|_$/g, '');
    if (filename.length > 100) {
      filename = filename.substring(0, 100);
    }
    const timestamp = Date.now();
    return `screenshots/${filename}_${timestamp}.${format}`;
  } catch {
    return `screenshots/screenshot_${Date.now()}.${format}`;
  }
}

// Capture single page screenshot
async function captureScreenshot(url, options) {
  let tabId = null;
  let debuggerAttached = false;

  try {
    // Create new tab
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;

    // Wait for page to load
    await waitForPageLoad(tabId);

    // Additional delay for dynamic content
    await delay(options.delay);

    // Click CSS selector element if specified
    if (options.clickSelector) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (selector) => {
            const el = document.querySelector(selector);
            if (el) el.click();
            return !!el;
          },
          args: [options.clickSelector]
        });
        // Wait for DOM changes after click
        await delay(500);
      } catch (e) {
        // Ignore selector click errors (element may not exist)
      }
    }

    // Step 1: Detect scroll container type
    let scrollContainerType = 'document'; // 'document' or 'element'
    try {
      const [detection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const docEl = document.documentElement;
          const body = document.body;
          const hasDocScroll = docEl.scrollHeight > docEl.clientHeight + 10;
          const hasBodyScroll = body.scrollHeight > body.clientHeight + 10;
          if (hasDocScroll || hasBodyScroll) return 'document';

          const allElements = document.querySelectorAll('*');
          for (const el of allElements) {
            const style = getComputedStyle(el);
            const ov = style.overflowY;
            if ((ov === 'auto' || ov === 'scroll' || ov === 'hidden') &&
                el.scrollHeight > el.clientHeight + 10) {
              // Tag it so we can find it again
              el.setAttribute('data-scroll-capture-target', 'true');
              return 'element';
            }
          }
          return 'document';
        }
      });
      scrollContainerType = detection.result || 'document';
    } catch (e) { /* ignore */ }

    // Step 2: Scroll simulation to trigger IntersectionObserver lazy-loading
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: async (containerType) => {
          const wait = (ms) => new Promise(r => setTimeout(r, ms));
          let scrollTarget;
          if (containerType === 'element') {
            scrollTarget = document.querySelector('[data-scroll-capture-target]');
          } else {
            scrollTarget = document.documentElement;
          }
          if (!scrollTarget) return;

          const step = scrollTarget.clientHeight;
          const maxScroll = scrollTarget.scrollHeight;
          let pos = 0;
          while (pos < maxScroll) {
            pos += step;
            scrollTarget.scrollTop = pos;
            await wait(250);
          }
          // Return to top
          scrollTarget.scrollTop = 0;
          await wait(200);
        },
        args: [scrollContainerType]
      });
    } catch (e) { /* ignore */ }

    // Step 3: Expand non-document scroll containers via CSS
    if (scrollContainerType === 'element') {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const target = document.querySelector('[data-scroll-capture-target]');
            if (!target) return;
            let current = target;
            while (current && current !== document.documentElement) {
              current.style.overflow = 'visible';
              current.style.height = 'auto';
              current.style.maxHeight = 'none';
              current = current.parentElement;
            }
            document.documentElement.style.overflow = 'visible';
            document.documentElement.style.height = 'auto';
            document.body.style.overflow = 'visible';
            document.body.style.height = 'auto';
          }
        });
        await delay(300);
      } catch (e) { /* ignore */ }
    }

    // Attach debugger
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          debuggerAttached = true;
          resolve();
        }
      });
    });

    // Enable Page domain
    await sendDebuggerCommand(tabId, 'Page.enable');

    // Get page layout metrics
    const metrics = await sendDebuggerCommand(tabId, 'Page.getLayoutMetrics');

    // Calculate dimensions (with max height limit to prevent memory issues)
    const width = Math.ceil(metrics.contentSize.width);
    const height = Math.min(Math.ceil(metrics.contentSize.height), 16384); // Max 16384px

    // Set device metrics to capture full page
    await sendDebuggerCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: width,
      height: height,
      deviceScaleFactor: 1,
      mobile: false
    });

    // Small delay for rendering
    await delay(100);

    // Capture screenshot
    const screenshot = await sendDebuggerCommand(tabId, 'Page.captureScreenshot', {
      format: options.format,
      quality: options.format === 'jpeg' ? 90 : undefined,
      captureBeyondViewport: true
    });

    // Generate filename and download
    const filename = generateFilename(url, options.format);
    const mimeType = options.format === 'png' ? 'image/png' : 'image/jpeg';

    await chrome.downloads.download({
      url: `data:${mimeType};base64,${screenshot.data}`,
      filename: filename,
      saveAs: false
    });

    return { success: true, filename };

  } finally {
    // Cleanup: detach debugger and close tab
    if (debuggerAttached && tabId) {
      try {
        await new Promise(resolve => {
          chrome.debugger.detach({ tabId }, resolve);
        });
      } catch (e) {
        // Ignore detach errors
      }
    }

    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {
        // Ignore tab removal errors
      }
    }
  }
}

// Notify popup of progress
async function notifyProgress(current, total, message, type = 'info', extra = {}) {
  try {
    await chrome.runtime.sendMessage({
      action: 'progressUpdate',
      current,
      total,
      message,
      type,
      ...extra
    });
  } catch (e) {
    // Popup might be closed, ignore
  }
}

// Get total count (processed + remaining in queue)
function getTotalCount() {
  return captureState.totalProcessed + captureState.queue.length;
}

const msg = chrome.i18n.getMessage;

// Handle capture request
async function handleCaptureRequest(urls, options) {
  const results = [];

  captureState.isRunning = true;
  captureState.isStopped = false;
  captureState.queue = [...urls];
  captureState.totalProcessed = 0;
  captureState.totalOriginal = urls.length;
  captureState.options = options;

  while (captureState.queue.length > 0) {
    // Check if stopped
    if (captureState.isStopped) {
      await notifyProgress(
        captureState.totalProcessed,
        getTotalCount(),
        msg('bgStoppedByUser'),
        'info',
        { remainingQueue: [...captureState.queue] }
      );
      break;
    }

    const url = captureState.queue.shift();
    const total = getTotalCount() + 1; // +1 because we just shifted

    await notifyProgress(
      captureState.totalProcessed,
      total,
      msg('bgCapturing', [url]),
      'info',
      { remainingQueue: [...captureState.queue] }
    );

    try {
      const result = await captureScreenshot(url, captureState.options);
      captureState.totalProcessed++;
      results.push({ url, ...result });
      await notifyProgress(
        captureState.totalProcessed,
        getTotalCount(),
        msg('bgSaved', [result.filename]),
        'success',
        { remainingQueue: [...captureState.queue] }
      );
    } catch (error) {
      captureState.totalProcessed++;
      results.push({ url, success: false, error: error.message });
      await notifyProgress(
        captureState.totalProcessed,
        getTotalCount(),
        msg('bgFailed', [url, error.message]),
        'error',
        { remainingQueue: [...captureState.queue] }
      );
    }

    // Small delay between captures
    if (captureState.queue.length > 0 && !captureState.isStopped) {
      await delay(500);
    }
  }

  captureState.isRunning = false;
  return results;
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'captureScreenshots') {
    handleCaptureRequest(message.urls, message.options)
      .then(results => {
        const allSuccess = results.every(r => r.success);
        sendResponse({
          success: allSuccess,
          results: results,
          stopped: captureState.isStopped,
          error: allSuccess ? null : 'Some captures failed'
        });
      })
      .catch(error => {
        sendResponse({
          success: false,
          error: error.message
        });
      });

    return true; // Keep channel open for async response
  }

  if (message.action === 'stopCapture') {
    captureState.isStopped = true;
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'updateQueue') {
    if (captureState.isRunning) {
      captureState.queue = [...message.urls];
      sendResponse({
        success: true,
        queueLength: captureState.queue.length,
        total: getTotalCount()
      });
    } else {
      sendResponse({ success: false, error: 'Not running' });
    }
    return false;
  }

  if (message.action === 'addToQueue') {
    if (captureState.isRunning) {
      captureState.queue.push(...message.urls);
      sendResponse({
        success: true,
        queueLength: captureState.queue.length,
        total: getTotalCount()
      });
    } else {
      sendResponse({ success: false, error: 'Not running' });
    }
    return false;
  }

  if (message.action === 'getState') {
    sendResponse({
      isRunning: captureState.isRunning,
      isStopped: captureState.isStopped,
      queueLength: captureState.queue.length,
      totalProcessed: captureState.totalProcessed,
      total: getTotalCount(),
      remainingQueue: [...captureState.queue]
    });
    return false;
  }
});
