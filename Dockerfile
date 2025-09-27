# Use the official Node.js 18 image as a parent image
FROM node:18-alpine AS builder

# Set the working directory in the container
WORKDIR /app

# Copy package.json and yarn.lock to the working directory
COPY package.json yarn.lock ./

# Install all dependencies
RUN yarn install --frozen-lockfile

# Copy the rest of the application's source code
COPY . .

# Build the TypeScript code
RUN yarn build

# Start a new stage for the production image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and yarn.lock
COPY package.json yarn.lock ./

# Install only production dependencies
RUN yarn install --production --frozen-lockfile

# Copy the compiled code from the builder stage
COPY --from=builder /app/dist ./dist

# Copy the lexicon files
COPY --from=builder /app/src/lexicon ./src/lexicon

# Expose the port the app runs on
EXPOSE 3000

# Define the command to run the application
CMD ["node", "dist/index.js"]
