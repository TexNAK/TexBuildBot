import os
import subprocess
from urllib.request import Request, urlopen
import urllib.parse
import json
import re
from time import sleep

maxLength = 18000
customDictionary = ["Blechschmidt", "Peeters"]


def error_included(typeID, string):
    if typeID == "TYPOS":
        if string in customDictionary or (string[-1] == "." and string[:-1] in customDictionary):
            return False

    return True


def spellcheck_pdfs(rootDir):
    markdown = ""
    numberOfErrors = 0
    for root, subFolders, files in os.walk(rootDir):
        for file in files:
            if file[-4:] == ".pdf":
                filePath = root + "/" + file
                process = subprocess.run(["pdftotext", filePath, "-"], stdout=subprocess.PIPE)
                content = process.stdout.decode('utf-8')

                repairedContent = re.sub("\n", "\n\n", re.sub("\n(?=\w)", " ", content))
                sentences = re.split("(?<=[\\.!?]) ", repairedContent)

                sentenceIndex = 0
                foundError = False

                while sentenceIndex < len(sentences):
                    text = ""

                    while sentenceIndex < len(sentences) and len(text) + len(sentences[sentenceIndex]) < maxLength:
                        if sentenceIndex == len(sentences) - 1:
                            text += sentences[sentenceIndex]
                        else:
                            text += sentences[sentenceIndex] + " "
                        sentenceIndex += 1

                    encodedContent = urllib.parse.quote_plus(text)

                    request = Request("https://languagetool.org/api/v2/check", str.encode("disabledRules=UPPERCASE_SENTENCE_START,DE_CASE,GERMAN_WORD_REPEAT_RULE,DE_PHRASE_REPETITION,COMMA_PARENTHESIS_WHITESPACE&text="+ encodedContent +"&language=de-DE"))
                    waitingForRequest = True

                    while waitingForRequest:
                        try:
                            response = urlopen(request).read()
                            decodedResponse = json.loads(response)

                            for match in decodedResponse['matches']:
                                message = match['message']
                                replacements = match['replacements']
                                offset = match['offset']
                                length = match['length']
                                errorID = match['rule']['category']['id']
                                string = repairedContent[offset:offset + length]
                                contextOffset = match['context']['offset']
                                contextText = match['context']['text']
                                contextEnd = contextOffset + length

                                markedContextText = contextText = contextText[:contextOffset] + "**" + contextText[contextOffset:contextEnd] + "**" + contextText[contextEnd:]

                                if error_included(errorID, string):
                                    foundError = True
                                    markdown += "|"+ errorID + ": " + match['rule']['id'] +"|\n"
                                    markdown += "|-|\n"
                                    markdown += "|" + markedContextText + "|\n"
                                    markdown += "|" + message + "|\n"
                                    markdown += "\n\n"
                                    numberOfErrors += 1

                                    if numberOfErrors == 20:
                                        return markdown

                            if not foundError:
                                markdown += "✅ Es wurden keine Fehler gefunden!\n"
                            waitingForRequest = False
                        except:
                            print("waiting")
                            sleep(60)
    return markdown


if __name__ == "__main__":
    import sys
    hasOutputFile = sys.argv[1] == "-o"

    markdown = ""
    for folder in sys.argv[(3 if hasOutputFile else 1):]:
        markdown += spellcheck_pdfs(folder)

    if hasOutputFile:
        f = open(sys.argv[2], "w")
        f.write(markdown)
        f.close()
    else:
        print(markdown)
