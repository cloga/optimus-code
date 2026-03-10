# Security Expert Review

## Feedback
React Server Components can be beneficial, but we must be extremely cautious about exposing sensitive server-side secrets directly to the client bundle.

## Concerns
When creating the `useDashboardData` hook and passing data from Server Components, ensure no environment variables or API keys are leaked in the serialized props. Please add a specific check or middleware to sanitize the data before it crosses the server-client boundary.

**Verdict**: Request Changes regarding data sanitization.
