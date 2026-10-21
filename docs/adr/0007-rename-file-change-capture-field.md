# Name captured additions and modifications changedFiles

Rename the file-change capture map to `metadata.fileChanges.changedFiles` because it contains both added and modified files, already distinguished by each entry's `change` value. Bump the file-change record's `schemaVersion` from 1 to 2 for every status because its shape changes; retain all other fields, behavior, and limits. The maintainer confirmed there are no external users, so this is a breaking metadata-field rename with no alias or compatibility shim, shipped in a minor release rather than a major release.
