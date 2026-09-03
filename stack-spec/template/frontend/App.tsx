import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StyleSheet, Text, View } from "react-native";
import { PaperProvider } from "react-native-paper";
import { theme } from "./src/theme";

// Structural placeholder — real screens live under src/screens/ and are
// registered in the stack below once this stops being a skeleton.
function PlaceholderScreen() {
  return (
    <View style={styles.container}>
      <Text>Structural skeleton — screens go here.</Text>
    </View>
  );
}

const Stack = createNativeStackNavigator();

export default function App() {
  return (
    <PaperProvider theme={theme}>
      <NavigationContainer>
        <Stack.Navigator>
          <Stack.Screen name="Placeholder" component={PlaceholderScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </PaperProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
