'use strict';

/**
 * This script is injected into every page and frame within a Container
 * that is taken offline.
 */

// In Firefox, this kills established WebSocket connections
window.stop();
