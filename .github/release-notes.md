Empty folder cleanup and per-device labels.

- Removes folders left empty after a sync applies a deletion made on another device. Git cannot store an empty directory, so such folders previously stayed behind on every other device with no way to remove them through sync.
- Names the local device in commit messages and conflict copies from the author name setting combined with the detected platform, instead of always writing `iPhone`. A desktop sync now reads `Sync vault from macbook-work (Mac)`, and a conflict copy is named after the device that produced it.
- Falls back to the detected platform when no author name is configured, and strips characters that are not valid in a vault path.
