#!/bin/bash
# Fix HTML in JSDoc comments for Vite compatibility

for file in background-interaction.js components.js theme-manager.js theme-toggle.js time-of-day-theme.js particle-generator.js; do
  if [ -f "$file" ]; then
    echo "Fixing $file..."
    # Backup
    cp "$file" "$file.backup"
    
    # Replace <script> tags in comments with @example code blocks
    sed -i.tmp 's/\* <script/\* @example\n \* \/\/ <script/g' "$file"
    sed -i.tmp 's/\* <\/script>/\* \/\/ <\/script>/g' "$file"
    
    # Replace other HTML tags in comments
    sed -i.tmp 's/\* </\* \\</g' "$file"
    sed -i.tmp 's/\*>/\*\\>/g' "$file"
    
    rm "$file.tmp"
    echo "  ✓ Fixed $file"
  fi
done

echo "Done! Backups saved with .backup extension"
