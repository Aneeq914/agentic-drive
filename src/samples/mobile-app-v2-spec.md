# Mobile App v2 — Engineering Spec

Owner: Engineering team
Status: Draft

## Goal
Rebuild the mobile app so files sync faster and work offline.

## Requirements
- The app must sync a 10 MB file in under 5 seconds on 4G.
- Users must be able to open recent files without an internet connection.
- The backend API should return search results in under 300 ms.
- We need to support both Android and iOS from one codebase.
- Push notifications are required when an agent finishes a task.

## Architecture
The frontend will use React Native. The backend API will run on Node.js with a PostgreSQL database. Files are stored in object storage and cached on the device.

## Release plan
Beta release to internal testers in sprint 14; public release in sprint 16.
