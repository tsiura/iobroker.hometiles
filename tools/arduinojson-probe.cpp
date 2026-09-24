// Ground truth for src/protocol/arduinojson.ts: how the panel's JSON library,
// ArduinoJson 7.4.3 (HomeTiles .github/workflows/firmware.yml:96), reads and
// prints the numbers of an editable value, run on the library itself.
// tools/arduinojson-fixture.cjs compiles and runs this and writes
// test/fixtures/arduinojson-golden.json from its output; see there.
//
// Input, one case per line: "r <JSON number>" or "p <JSON number>".
//   r  a number the adapter publishes as min, max or step. The panel's
//      finite_json (value_control.cpp:28-34) deserializes it and serializes
//      it back, then strtod's that text. Prints the text, then the text a
//      float correctly rounded from the number prints -- the Math.fround
//      shortcut the port must not take -- or "-" when the library does not
//      parse the number as a float.
//   p  a double the panel holds: submit() assigns it to a document
//      (value_control.cpp:306) and serializes it. Prints that text, then the
//      text the same double prints with 9 decimals, always.
#include <ArduinoJson.h>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>

namespace aj = ArduinoJson::detail;

// The library's own float printer, with the decimals given (TextFormatter.hpp:72).
static std::string printed(double value, int8_t decimals) {
  std::string text;
  aj::Writer<std::string> writer(text);
  aj::TextFormatter<aj::Writer<std::string>> formatter(writer);
  formatter.writeFloat(value, decimals);
  return text;
}

int main() {
  std::printf("version %s\n", ARDUINOJSON_VERSION);
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.size() < 3 || line[1] != ' ') {
      std::printf("ERR\n");
      continue;
    }
    const std::string number = line.substr(2);
    if (line[0] == 'r') {
      JsonDocument doc;
      if (deserializeJson(doc, "{\"v\":" + number + "}")) {
        std::printf("ERR\n");
        continue;
      }
      std::string text;
      serializeJson(doc["v"], text);
      const bool single = aj::parseNumber(number.c_str()).type() == aj::NumberType::Float;
      const std::string shortcut = single ? printed(static_cast<float>(std::strtod(number.c_str(), nullptr)), 6) : "-";
      std::printf("%s %s\n", text.c_str(), shortcut.c_str());
    } else {
      const double held = std::strtod(number.c_str(), nullptr);
      JsonDocument doc;
      doc["value"] = held;
      std::string text;
      serializeJson(doc["value"], text);
      std::printf("%s %s\n", text.c_str(), printed(held, 9).c_str());
    }
  }
}
