# Ledger

- row "USER, Images ×1 · Files ×1 · Using one run_code program, read the attached file with the read tool and return its contents, then reply with exactly the single word the file contains, and stop.":
  - cell "Turn 1 USER": USER
  - cell "Images ×1 · Files ×1 · Using one run_code program, read the attached file with the read tool and return its contents, then reply with exactly the single word the file contains, and stop."

# Summary attachments

- list "Attachments":
  - listitem: poem.txt TXT · 16B
  - listitem:
    - button "reference-1.png, click to view original":
      - img "reference-1.png"
    - text: reference-1.png image/png · 69B · 1 × 1

# Preview

- tabpanel "Preview":
  - paragraph: Using one run_code program, read the attached file with the read tool and return its contents, then reply with exactly the single word the file contains, and stop.
  - list "Attachments":
    - listitem: poem.txt TXT · 16B
    - listitem:
      - button "reference-1.png, click to view original":
        - img "reference-1.png"
      - text: reference-1.png image/png · 69B · 1 × 1

# Raw (collapsed)

- tabpanel "Raw":
  - group: "Block #1 file poem.txt"
  - group: "Block #2 image reference-1.png"
  - text: "Block #3 text Using one run_code program, read the attached file with the read tool and return its contents, then reply with exactly the single word the file contains, and stop."

# Raw (expanded)

- tabpanel "Raw":
  - group: "Block #1 file poem.txt { \"type\": \"file\", \"attachment\": { \"attachmentId\": \"sha256:29a0837077f6f3cbddd98c0605897cc6f2b4e5833fb8e1ca4a8045d89b2c8c60\", \"name\": \"poem.txt\", \"bytes\": 16 } }"
  - group: "Block #2 image reference-1.png { \"type\": \"image\", \"attachment\": { \"attachmentId\": \"sha256:b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640\", \"mediaType\": \"image/png\", \"width\": 1, \"height\": 1, \"bytes\": 69, \"name\": \"reference-1.png\" } }"
  - text: "Block #3 text Using one run_code program, read the attached file with the read tool and return its contents, then reply with exactly the single word the file contains, and stop."
