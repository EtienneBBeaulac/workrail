#!/usr/bin/env python3
import re
import sys

def fix_jsdoc_html(content):
    """Remove or escape HTML tags in JSDoc comments"""
    
    # Pattern to match JSDoc comment blocks with HTML
    def process_comment(match):
        comment = match.group(0)
        # If comment contains HTML-like tags, remove them or escape
        if '<' in comment and '>' in comment:
            # Remove HTML examples from JSDoc
            comment = re.sub(r'\*\s*<[^>]+>.*?<\/[^>]+>', '* [HTML example removed for Vite compatibility]', comment, flags=re.DOTALL)
            # Escape remaining angle brackets
            comment = comment.replace('<', '&lt;').replace('>', '&gt;')
        return comment
    
    # Match JSDoc comments (/** ... */)
    content = re.sub(r'/\*\*.*?\*/', process_comment, content, flags=re.DOTALL)
    
    return content

files = [
    'background-interaction.js',
    'components.js', 
    'theme-manager.js',
    'theme-toggle.js',
    'time-of-day-theme.js',
    'particle-generator.js'
]

for filename in files:
    try:
        with open(filename, 'r', encoding='utf-8') as f:
            content = f.read()
        
        fixed_content = fix_jsdoc_html(content)
        
        with open(filename, 'w', encoding='utf-8') as f:
            f.write(fixed_content)
        
        print(f"✓ Fixed {filename}")
    except Exception as e:
        print(f"✗ Error fixing {filename}: {e}", file=sys.stderr)

print("\nAll files processed!")
