# Playwright-enabled base image met Chromium
FROM apify/actor-node-playwright-chrome:22

# Check preinstalled packages
RUN npm ls @crawlee/core apify playwright || true

# Copy package files first for Docker layer cache
COPY --chown=myuser:myuser package*.json ./

# Install dependencies
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

# Copy source code
COPY --chown=myuser:myuser . ./

CMD ["node", "src/main.js"]
