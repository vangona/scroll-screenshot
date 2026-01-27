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

// Wait for network idle using CDP Network events
function waitForNetworkIdle(tabId, idleTime = 500, timeout = 5000) {
  return new Promise((resolve) => {
    let pendingRequests = 0;
    let idleTimer = null;
    let timeoutTimer = null;

    const checkIdle = () => {
      if (pendingRequests <= 0) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          cleanup();
          resolve();
        }, idleTime);
      }
    };

    const onEvent = (source, method) => {
      if (source.tabId !== tabId) return;
      if (method === 'Network.requestWillBeSent') {
        pendingRequests++;
        clearTimeout(idleTimer);
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        pendingRequests = Math.max(0, pendingRequests - 1);
        checkIdle();
      }
    };

    const cleanup = () => {
      chrome.debugger.onEvent.removeListener(onEvent);
      clearTimeout(timeoutTimer);
      clearTimeout(idleTimer);
    };

    chrome.debugger.onEvent.addListener(onEvent);

    // Hard timeout
    timeoutTimer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeout);

    // Start idle check immediately
    checkIdle();
  });
}

// Viewport presets: width, height, deviceScaleFactor, mobile
const VIEWPORT_PRESETS = {
  pc:     { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, userAgent: '' },
  tablet: { width: 768,  height: 1024, deviceScaleFactor: 2, mobile: true,
            userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  mobile: { width: 375,  height: 812,  deviceScaleFactor: 3, mobile: true,
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }
};

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

  // Helper to abort early if stop was requested
  function checkStopped() {
    if (captureState.isStopped) {
      throw new Error('STOPPED_BY_USER');
    }
  }

  try {
    // Create new tab
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;

    // Wait for page to load
    await waitForPageLoad(tabId);
    checkStopped();

    // Additional delay for dynamic content
    await delay(options.delay);
    checkStopped();

    // Attach debugger early (before scroll) to enable Network tracking
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

    await sendDebuggerCommand(tabId, 'Page.enable');
    await sendDebuggerCommand(tabId, 'Network.enable');

    // Set viewport size based on device preset
    const preset = VIEWPORT_PRESETS[options.viewport] || VIEWPORT_PRESETS.pc;
    await sendDebuggerCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: preset.width,
      height: preset.height,
      deviceScaleFactor: preset.deviceScaleFactor,
      mobile: preset.mobile
    });

    // Set mobile User-Agent so server-side rendering returns mobile layout
    if (preset.userAgent) {
      await sendDebuggerCommand(tabId, 'Emulation.setUserAgentOverride', {
        userAgent: preset.userAgent
      });
    }

    // Reload page so it re-renders at the new viewport size
    // Use CDP Page.loadEventFired instead of chrome.tabs.onUpdated to avoid race condition
    await new Promise((resolve) => {
      const onEvent = (source, method) => {
        if (source.tabId === tabId && method === 'Page.loadEventFired') {
          chrome.debugger.onEvent.removeListener(onEvent);
          resolve();
        }
      };
      chrome.debugger.onEvent.addListener(onEvent);
      sendDebuggerCommand(tabId, 'Page.reload');
    });
    await delay(options.delay);
    checkStopped();

    // Click CSS selector element if specified (after viewport resize + reload)
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
        await delay(500);
      } catch (e) {
        // Ignore selector click errors (element may not exist)
      }
    }
    checkStopped();

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
    } catch (e) {
      console.warn('[ScrollScreenshot] Scroll container detection failed:', e.message);
    }

    // Step 2: Scroll simulation to trigger IntersectionObserver lazy-loading
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: async (containerType, scrollWaitMs) => {
          const wait = (ms) => new Promise(r => setTimeout(r, ms));

          // Wait for DOM mutations to settle
          function waitForDomSettle(timeout = scrollWaitMs) {
            return new Promise(resolve => {
              let timer = null;
              const observer = new MutationObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                  observer.disconnect();
                  resolve();
                }, 200);
              });
              observer.observe(document.body, { childList: true, subtree: true });
              timer = setTimeout(() => {
                observer.disconnect();
                resolve();
              }, timeout);
            });
          }

          // Wait for images visible in the current viewport to load
          function waitForVisibleImages(scrollTarget, timeout = 2000) {
            const images = document.querySelectorAll('img');
            const pending = [];
            for (const img of images) {
              const rect = img.getBoundingClientRect();
              if (rect.bottom >= 0 && rect.top <= scrollTarget.clientHeight) {
                if (!img.complete || img.naturalWidth === 0) {
                  pending.push(img);
                }
              }
            }
            if (pending.length === 0) return Promise.resolve();
            const deadline = Date.now() + timeout;
            return Promise.all(pending.map(img => {
              return new Promise(resolve => {
                if (img.complete && img.naturalWidth > 0) return resolve();
                const onDone = () => resolve();
                img.addEventListener('load', onDone, { once: true });
                img.addEventListener('error', onDone, { once: true });
                setTimeout(onDone, Math.max(deadline - Date.now(), 0));
              });
            }));
          }

          let scrollTarget;
          if (containerType === 'element') {
            scrollTarget = document.querySelector('[data-scroll-capture-target]');
          } else {
            scrollTarget = document.documentElement;
          }
          if (!scrollTarget) return;

          const step = Math.max(Math.floor(scrollTarget.clientHeight / 2), 100);
          let maxScroll = scrollTarget.scrollHeight;
          let pos = 0;

          while (pos < maxScroll) {
            pos = Math.min(pos + step, maxScroll);
            scrollTarget.scrollTop = pos;

            // Wait for IntersectionObserver callbacks to fire
            await wait(100);
            // Wait for DOM to settle (lazy-loaded content injection)
            await waitForDomSettle(500);
            // Wait for visible images to load
            await waitForVisibleImages(scrollTarget, 2000);

            // Re-check scrollHeight in case content was added
            const newMax = scrollTarget.scrollHeight;
            if (newMax > maxScroll + 50) {
              maxScroll = newMax;
            }
          }

          // Ensure last elements are triggered
          scrollTarget.scrollTop = scrollTarget.scrollHeight;
          await wait(100);
          await waitForVisibleImages(scrollTarget, 2000);

          // Return to top
          scrollTarget.scrollTop = 0;
          await wait(500);
        },
        args: [scrollContainerType, options.scrollWait ?? 500]
      });
    } catch (e) {
      console.warn('[ScrollScreenshot] Scroll simulation failed:', e.message);
    }

    checkStopped();

    // Step 3: Wait for network idle after scroll-triggered lazy loading
    try {
      await waitForNetworkIdle(tabId, 500, 5000);
    } catch (e) {
      console.warn('[ScrollScreenshot] Network idle wait failed:', e.message);
    }
    checkStopped();

    // Step 4: Final verification - wait for all images on the page to load
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          const images = Array.from(document.querySelectorAll('img'));
          const pending = images.filter(img => !img.complete || img.naturalWidth === 0);
          if (pending.length === 0) return;
          await Promise.all(pending.map(img => {
            return new Promise(resolve => {
              if (img.complete && img.naturalWidth > 0) return resolve();
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
              setTimeout(resolve, 3000);
            });
          }));
        }
      });
    } catch (e) {
      console.warn('[ScrollScreenshot] Final image verification failed:', e.message);
    }

    // Step 5: Expand non-document scroll containers via CSS
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
      } catch (e) {
        console.warn('[ScrollScreenshot] CSS expansion failed:', e.message);
      }
    }

    // Get page layout metrics
    const metrics = await sendDebuggerCommand(tabId, 'Page.getLayoutMetrics');

    // Calculate dimensions (with max height limit to prevent memory issues)
    const width = Math.ceil(metrics.contentSize.width);
    const height = Math.min(Math.ceil(metrics.contentSize.height), 16384); // Max 16384px

    // Set device metrics to capture full page (preserve viewport preset settings)
    await sendDebuggerCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: width,
      height: height,
      deviceScaleFactor: preset.deviceScaleFactor,
      mobile: preset.mobile
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
      if (error.message === 'STOPPED_BY_USER') {
        // Re-add URL back to queue since it wasn't completed
        captureState.queue.unshift(url);
        break;
      }
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
